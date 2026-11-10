import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@huranth/gama-ai";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "timers/promises";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { writeFileAtomicSync } from "../utils/atomic-write.ts";
import { getFileRevision, normalizePath } from "../utils/paths.ts";
import { sleepSync } from "../utils/sleep.ts";
import { stripBom } from "../utils/text.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

type AuthStorageData = Record<string, Credential>;

type LockResult<T> = {
	result: T;
	next?: string;
};

type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

type AuthFileReadState = {
	data: AuthStorageData;
	revision?: string;
	reload?: AuthFileReload;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T>;
}

const AUTH_FILE_MODE = 0o600;

const INVALID_AUTH_SHAPE = "Invalid auth file";

const LOCK_STALE_MS = 30_000;

const LOCK_MAX_DELAY_MS = 2_000;

const LOCK_RETRY_BASE_MS = 10;

const sharedAuthFileReadStates = new Map<string, AuthFileReadState>();

function readErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;

	return String((error as { code?: unknown }).code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isValidCredential(value: Record<string, unknown>): boolean {
	if (value.type === "api_key") {
		const validKey = value.key === undefined || typeof value.key === "string";
		const validEnv = value.env === undefined || isStringRecord(value.env);

		return validKey && validEnv;
	}

	return (
		value.type === "oauth" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		Number.isFinite(value.expires)
	);
}

export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = JSON.parse(stripBom(readFileSync(normalizePath(authPath), "utf-8")));
		if (!isRecord(data)) return undefined;
		const credential = data[providerId];
		return isRecord(credential) && isValidCredential(credential)
			? (credential as unknown as Credential)
			: undefined;
	} catch (error) {
		if (error instanceof SyntaxError) throw error;
		return undefined;
	}
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (existsSync(this.authPath)) return;
		try {
			writeFileSync(this.authPath, "{}", {
				encoding: "utf-8",
				flag: "wx",
				mode: AUTH_FILE_MODE,
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	private writeAuthFile(next: string): void {
		// Owner only
		let mode = AUTH_FILE_MODE;
		if (existsSync(this.authPath)) {
			try {
				mode = statSync(this.authPath).mode & 0o600;
			} catch {
				mode = AUTH_FILE_MODE;
			}
		}
		writeFileAtomicSync(this.authPath, next, mode);
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;

		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code = readErrorCode(error);
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}

				lastError = error;
				sleepSync(delayMs);
			}
		}

		throw (lastError as Error) ?? new Error("Auth lock failed");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);

			const current = existsSync(this.authPath)
				? readFileSync(this.authPath, "utf-8")
				: undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				this.writeAuthFile(next);
			}

			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	private async acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		const deadline = Date.now() + LOCK_STALE_MS;

		let retry = 0;
		while (true) {
			signal?.throwIfAborted();

			let release: (() => Promise<void>) | undefined;
			try {
				release = await lockfile.lock(this.authPath, {
					realpath: false,
					retries: 0,
					stale: LOCK_STALE_MS,
					onCompromised,
				});
			} catch (error) {
				signal?.throwIfAborted();

				const code = readErrorCode(error);
				const remainingMs = deadline - Date.now();
				if (code !== "ELOCKED" || remainingMs <= 0) throw error;

				const baseDelayMs = Math.min(LOCK_RETRY_BASE_MS * 2 ** retry, LOCK_MAX_DELAY_MS / 2);
				const spread = 1 + Math.random();
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * spread), remainingMs);

				if (signal) {
					await sleep(delayMs, undefined, { signal });
				} else {
					await sleep(delayMs);
				}
				continue;
			}

			if (signal?.aborted) {
				await release();
				signal.throwIfAborted();
			}

			return release;
		}
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;

		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth lock broken");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();

			const current = existsSync(this.authPath)
				? readFileSync(this.authPath, "utf-8")
				: undefined;
			const { result, next } = await fn(current);

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.writeAuthFile(next);
			}

			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const previous = this.asyncChain;
		const operation = (async () => {
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		})();
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}

export class AuthStorage implements CredentialStore {
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private readState: AuthFileReadState;

	private constructor(storage: AuthStorageBackend, authPath?: string) {
		this.storage = storage;
		this.authPath = authPath;
		const sharedReadState = authPath ? sharedAuthFileReadStates.get(authPath) : undefined;
		this.readState = sharedReadState ?? { data: {} };
		if (authPath && !sharedReadState) {
			sharedAuthFileReadStates.set(authPath, this.readState);
		}
		if (authPath) {
			const revision = getFileRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(content));
		} catch {
			// No parser
			throw new Error("Invalid auth file");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(INVALID_AUTH_SHAPE);
		}
		for (const [providerId, credential] of Object.entries(parsed)) {
			if (!isRecord(credential) || !isValidCredential(credential)) {
				throw new Error(`Invalid credential: ${providerId}`);
			}
		}
		return parsed as AuthStorageData;
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
	}

	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			this.updateReadState({}, undefined);
		}
	}

	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.updateReadState(currentData, revision);
			return { result: currentData };
		}, options);
	}

	private async readLatestOrStale(promise: Promise<AuthStorageData>): Promise<AuthStorageData> {
		try {
			return await promise;
		} catch (error) {
			if ((error as { name?: string }).name !== "AbortError") {
				this.updateReadState({}, undefined);
				throw error;
			}
			return this.readState.data;
		}
	}

	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			const reload = this.reloadFromStorageAsync(options);
			return options?.signal ? reload : this.readLatestOrStale(reload);
		}
		const revision = getFileRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) {
			return this.readState.data;
		}

		if (!this.readState.reload) {
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;

		try {
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			return options?.signal ? await result : await this.readLatestOrStale(result);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const credential = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();

		if (credential?.type !== "api_key") {
			return credential === undefined ? undefined : structuredClone(credential);
		}
		if (credential.key === undefined) return structuredClone(credential);

		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;

		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const current = currentData[provider];
			const next = await fn(current === undefined ? undefined : structuredClone(current));
			if (next === undefined) {
				latestData = currentData;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;

			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);

		this.updateReadState(latestData, this.authPath ? getFileRevision(this.authPath) : undefined);
		return result;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		let latestData = this.readState.data;

		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);

		this.updateReadState(latestData, this.authPath ? getFileRevision(this.authPath) : undefined);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = Object.entries(await this.readLatestData(options));
		options?.signal?.throwIfAborted();
		return entries.map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}
