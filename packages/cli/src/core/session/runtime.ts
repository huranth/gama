import { constants, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import type { RunSession } from "./session.ts";
import type {
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "./services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../ext/index.ts";
import { emitSessionShutdownEvent } from "../ext/runner.ts";
import type { CreateAgentSessionResult } from "../kit.ts";
import { assertSessionCwdExists } from "../session-cwd.ts";
import { SessionStore } from "../sessions.ts";

export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionStore;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

const IMPORT_SUFFIX_START = 1;

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;

	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function uniqueSessionPath(sessionDir: string, fileName: string): string {
	const { name, ext } = parse(fileName);

	let suffix = IMPORT_SUFFIX_START;
	let target = join(sessionDir, fileName);

	while (existsSync(target)) {
		target = join(sessionDir, `${name}-${suffix++}${ext}`);
	}

	return target;
}

export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

export class SessionRuntime {
	private rebindSession?: (session: RunSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: RunSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;

	constructor(
		_session: RunSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	// Getters
	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): RunSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	// Mutators
	setRebindSession(rebindSession?: (session: RunSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	async dispose(): Promise<void> {
		await this.teardownCurrent("quit");
	}

	// Guards
	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;

		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});

		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;

		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});

		return { cancelled: result?.cancel === true };
	}

	// Lifecycle
	private async teardownCurrent(
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<void> {
		await this.session.abort();

		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});

		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async startSession(
		reason: "new" | "resume" | "fork",
		sessionManager: SessionStore,
		cwd: string,
		previousSessionFile: string | undefined,
		projectTrustContext?: ProjectTrustContext,
	): Promise<void> {
		const next = await this.createRuntime({
			cwd,
			agentDir: this.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason, previousSessionFile },
			projectTrustContext,
		});

		try {
			await this.teardownCurrent(reason, sessionManager.getSessionFile());
		} catch (error) {
			next.session.dispose();
			throw error;
		}

		this.apply(next);
	}

	private async replaceSession(
		reason: "new" | "resume" | "fork",
		sessionManager: SessionStore,
		cwd: string,
		previousSessionFile: string | undefined,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<void> {
		await this.startSession(reason, sessionManager, cwd, previousSessionFile);
		await this.finishSessionReplacement(withSession);
	}

	private async finishSessionReplacement(
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	// Switch
	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);

		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionStore.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);

		const cwd = sessionManager.getCwd();
		const projectTrustContext = options?.projectTrustContextFactory?.(cwd);

		await this.startSession(
			"resume",
			sessionManager,
			cwd,
			previousSessionFile,
			projectTrustContext,
		);
		await this.finishSessionReplacement(options?.withSession);

		return { cancelled: false };
	}

	// Create
	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionStore) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");

		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const previousSessionManager = this.session.sessionManager;
		const sessionDir = previousSessionManager.getSessionDir();

		const sessionManager = previousSessionManager.isPersisted()
			? SessionStore.create(this.cwd, sessionDir)
			: SessionStore.inMemory(this.cwd);

		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.startSession("new", sessionManager, this.cwd, previousSessionFile);

		try {
			if (options?.setup) {
				await options.setup(this.session.sessionManager);
				this.session.refreshContext();
			}
			await this.finishSessionReplacement(options?.withSession);
		} catch (error) {
			try {
				await this.startSession("resume", previousSessionManager, this.cwd, previousSessionFile);
				await this.finishSessionReplacement();
			} catch (restoreError) {
				throw new AggregateError([error, restoreError], "Session replacement failed");
			}
			throw error;
		}

		return { cancelled: false };
	}

	// Fork
	async fork(
		entryId: string,
		options?: {
			position?: "before" | "at";
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		},
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });

		if (beforeResult.cancelled) {
			return { cancelled: true };
		}

		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);

		if (!selectedEntry) {
			throw new Error("Invalid forking entry");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid forking entry");
			}

			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		const persisted = this.session.sessionManager.isPersisted();

		if (persisted) {
			const currentSessionFile = this.session.sessionFile;

			if (!currentSessionFile) {
				throw new Error("Missing session file");
			}

			const sessionDir = this.session.sessionManager.getSessionDir();

			if (!targetLeafId) {
				const sessionManager = SessionStore.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });

				await this.replaceSession(
					"fork",
					sessionManager,
					this.cwd,
					previousSessionFile,
					options?.withSession,
				);

				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error("Session not saved");
			}

			const sessionManager = SessionStore.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);

			if (!forkedSessionPath) {
				throw new Error("Fork failed");
			}

			await this.replaceSession(
				"fork",
				sessionManager,
				sessionManager.getCwd(),
				previousSessionFile,
				options?.withSession,
			);

			return { cancelled: false, selectedText };
		}

		const sessionManager = SessionStore.inMemory(
			this.cwd,
			undefined,
			this.session.sessionManager.getEntries(),
		);

		if (targetLeafId) {
			sessionManager.createBranchedSession(targetLeafId);
		} else {
			sessionManager.newSession({ parentSession: previousSessionFile });
		}

		await this.replaceSession(
			"fork",
			sessionManager,
			this.cwd,
			previousSessionFile,
			options?.withSession,
		);

		return { cancelled: false, selectedText };
	}

	// Import
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);

		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();

		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const fileName = basename(resolvedPath);
		const storedPath = join(sessionDir, fileName);
		const sourceAlreadyStored = resolve(storedPath) === resolvedPath;
		const destinationPath = sourceAlreadyStored
			? storedPath
			: uniqueSessionPath(sessionDir, fileName);

		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);

		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		let copied = false;

		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
			copied = true;
		}

		let sessionManager: SessionStore;

		try {
			sessionManager = SessionStore.open(destinationPath, sessionDir, cwdOverride);
			assertSessionCwdExists(sessionManager, this.cwd);
		} catch (error) {
			if (copied) rmSync(destinationPath, { force: true });
			throw error;
		}

		await this.replaceSession(
			"resume",
			sessionManager,
			sessionManager.getCwd(),
			previousSessionFile,
		);

		return { cancelled: false };
	}
}

export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionStore;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<SessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new SessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./services.ts";
