import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@huranth/gama-ai";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { getFileRevision, normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./vault.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

type ModelsFileReload = {
	controller: AbortController;
	promise: Promise<StoredModels>;
	readers: number;
};

type ModelsFileReadState = {
	data: StoredModels;
	revision?: string;
	reload?: ModelsFileReload;
};

const sharedModelsFileReadStates = new Map<string, ModelsFileReadState>();

export class InMemoryCodingAgentModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(
		providerId: string,
		options?: ModelsStoreOperationOptions,
	): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(
		providerId: string,
		entry: ModelsStoreEntry,
		options?: ModelsStoreOperationOptions,
	): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.delete(providerId);
	}
}

export class FileModelsStore implements ModelsStore {
	private readonly storage: AuthStorageBackend;
	private readonly path: string;
	private readonly readState: ModelsFileReadState;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
		this.storage = new FileAuthStorageBackend(this.path);

		const sharedReadState = sharedModelsFileReadStates.get(this.path);
		this.readState = sharedReadState ?? { data: {} };
		if (!sharedReadState) sharedModelsFileReadStates.set(this.path, this.readState);
	}

	private parse(content: string | undefined): StoredModels {
		if (!content) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(content));
		} catch {
			throw new Error("Invalid models file");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Invalid models file");
		}
		return parsed as StoredModels;
	}

	private updateReadState(
		readState: ModelsFileReadState,
		data: StoredModels,
		revision?: string,
	): void {
		readState.data = data;
		readState.revision = revision;
	}

	private reloadFromStorage(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		return this.storage.withLockAsync(async (content) => {
			const data = this.parse(content);
			this.updateReadState(readState, data, getFileRevision(this.path));
			return { result: data };
		}, options);
	}

	private async readLatest(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		options?.signal?.throwIfAborted();
		const revision = getFileRevision(this.path);
		if (revision !== undefined && revision === readState.revision) return readState.data;
		if (!readState.reload) {
			const controller = new AbortController();
			const reload: ModelsFileReload = {
				controller,
				promise: this.reloadFromStorage(readState, { signal: controller.signal }),
				readers: 0,
			};
			readState.reload = reload;
			const clearReload = (): void => {
				if (readState.reload === reload) readState.reload = undefined;
			};
			void reload.promise.then(clearReload, clearReload);
		}

		const reload = readState.reload;
		reload.readers++;
		try {
			return await raceWithAbortSignal(reload.promise, options?.signal);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && readState.reload === reload) {
				readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	private async mutate(
		change: (current: StoredModels) => void,
		options?: ModelsStoreOperationOptions,
	): Promise<void> {
		let latest: StoredModels | undefined;

		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			change(current);
			latest = current;
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);

		if (latest) this.updateReadState(this.readState, latest);
	}

	async read(
		providerId: string,
		options?: ModelsStoreOperationOptions,
	): Promise<ModelsStoreEntry | undefined> {
		const entry = (await this.readLatest(this.readState, options))[providerId];
		options?.signal?.throwIfAborted();
		return entry ? structuredClone(entry) : undefined;
	}

	async write(
		providerId: string,
		entry: ModelsStoreEntry,
		options?: ModelsStoreOperationOptions,
	): Promise<void> {
		return this.mutate((current) => {
			current[providerId] = structuredClone(entry);
		}, options);
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		return this.mutate((current) => {
			delete current[providerId];
		}, options);
	}
}
