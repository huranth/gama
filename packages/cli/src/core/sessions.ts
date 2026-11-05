import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	getCurrentSystemMessage,
	type ImageContent,
	type Message,
	type TextContent,
	type Usage,
} from "@huranth/gama-ai";
import { getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { sleepSync } from "../utils/sleep.ts";
import type { BashExecutionMessage, CustomMessage } from "./msg.ts";
import {
	CURRENT_SESSION_VERSION,
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	type ContextEditableContent,
	createSessionId,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	generateId,
	getLatestCompactionEntry,
	type LabelEntry,
	migrateSessionEntries,
	migrateToCurrentVersion,
	type ModelChangeEntry,
	type NewSessionOptions,
	serializeSessionFileEntry,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfoEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
	type UsageEntry,
} from "./session/entries.ts";
import {
	ALL_SESSION_LIST_PUBLISH_INTERVAL,
	appendSessionLine,
	assertSessionFileFree,
	assertValidSessionId,
	buildSessionInfosWithConcurrency,
	enforceSessionFileMode,
	findMostRecentSession,
	getDefaultSessionDir,
	getDefaultSessionDirPath,
	isSessionFileName,
	listSessionsFromDir,
	MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
	mapWithConcurrency,
	RENAME_ATTEMPTS,
	RETRY_RENAME_DELAY_MS,
	SESSION_DIR_MODE,
	SESSION_FILE_EXTENSION,
	SESSION_FILE_MODE,
	type SessionFileCandidate,
	type SessionInfo,
	type SessionListProgress,
	sortSessionInfos,
	writeSessionFileAtomically,
} from "./session/files.ts";
import {
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	type ProjectedSessionEntry,
	type SessionContext,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "./session/projection.ts";
import {
	buildSessionTree,
	createLabelEntries,
	isEditableEntry,
	isValidReplacement,
	retargetEntry,
	type SessionTreeNode,
	walkBranch,
} from "./session/tree.ts";
import {
	getSessionHeaderCwd,
	loadEntriesFromFile,
	loadSessionFile,
	readSessionHeader,
	readSessionHeaderForDiscovery,
	SessionHeaderScanLimitError,
	sessionCwdMatches,
} from "./session-file.ts";

export { loadEntriesFromFile, loadSessionFile, parseSessionEntries } from "./session-file.ts";

export type { SessionFileLoad } from "./session-file.ts";

// Entry types
export {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	migrateSessionEntries,
	serializeSessionFileEntry,
};

export type {
	BranchSummaryEntry,
	CompactionEntry,
	ContextEditEntry,
	ContextEditableContent,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	LabelEntry,
	ModelChangeEntry,
	NewSessionOptions,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfoEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
	UsageEntry,
};

// File helpers
export {
	SESSION_DIR_MODE,
	SESSION_FILE_EXTENSION,
	SESSION_FILE_MODE,
	assertValidSessionId,
	findMostRecentSession,
	getDefaultSessionDir,
	isSessionFileName,
};

export type { SessionInfo, SessionListProgress };

// Projection helpers
export { buildContextEntries, buildSessionContext, buildSessionProjection };

export { sessionEntryToContextMessages };

export type { ProjectedSessionEntry, SessionContext, SessionProjection };

// Tree types
export type { SessionTreeNode };

export type ReadonlySessionManager = Pick<
	SessionStore,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "buildSessionProjection"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

export class SessionStore {
	private sessionId: string = "";
	private sessionFile: string | undefined;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	private flushed: boolean = false;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	private labelsById: Map<string, string> = new Map();
	private labelTimestampsById: Map<string, string> = new Map();
	private leafId: string | null = null;
	private appendRecoveryNeeded = false;
	private persistFailure = false;
	private skippedLines = 0;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;

		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true, mode: SESSION_DIR_MODE });
		}

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else if (preloadedFileEntries?.length) {
			this._loadEntries(preloadedFileEntries, newSessionOptions);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		this.skippedLines = 0;

		if (existsSync(this.sessionFile)) {
			if (this.persist) enforceSessionFileMode(this.sessionFile);

			const loaded = preloadedFileEntries
				? { entries: preloadedFileEntries, skipped: 0 }
				: loadSessionFile(this.sessionFile);
			const entries = loaded.entries;
			this.skippedLines = loaded.skipped;

			if (entries.length === 0) {
				const explicitPath = this.sessionFile;

				if (statSync(explicitPath).size > 0) {
					throw new Error(`Invalid session file: ${explicitPath}`);
				}

				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			this._loadEntries(entries);
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath;
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);

			if (this.persist) {
				assertSessionFileFree(
					join(this.getSessionDir(), `${options.id}${SESSION_FILE_EXTENSION}`),
					options.id,
				);
			}
		}

		this.sessionId = options?.id ?? createSessionId();

		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};

		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;
		this.persistFailure = false;

		if (this.persist) {
			this.sessionFile = join(this.getSessionDir(), `${this.sessionId}${SESSION_FILE_EXTENSION}`);
		}

		return this.sessionFile;
	}

	private _loadEntries(entries: FileEntry[], options?: NewSessionOptions): void {
		const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;

		if (header) {
			this.fileEntries = entries;
			this.sessionId = header.id;

			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}
		} else {
			const explicitPath = this.sessionFile;
			this.newSession(options);

			if (explicitPath) this.sessionFile = explicitPath;

			this.fileEntries = this.fileEntries.concat(entries);
		}

		this._buildIndex();
	}

	private _buildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;

		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;

			this.byId.set(entry.id, entry);
			this.leafId = entry.id;

			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;

		this._writeFile(this.sessionFile, this.fileEntries);
	}

	private _writeFile(path: string, entries: FileEntry[]): void {
		const lines = entries.map((entry) => `${serializeSessionFileEntry(entry)}\n`);

		for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
			try {
				writeSessionFileAtomically(path, lines);
				return;
			} catch (error) {
				// Retry rename
				if (attempt === RENAME_ATTEMPTS - 1) throw error;

				sleepSync(RETRY_RENAME_DELAY_MS);
			}
		}
	}

	isPersisted(): boolean {
		return this.persist && !this.persistFailure;
	}

	// Write header
	persistHeader(): void {
		if (!this.persist || !this.sessionFile || this.flushed) return;

		try {
			this._writeAllEntries();
		} catch (error) {
			this.persistFailure = true;
			throw error;
		}
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		const configured = resolvePath(this.sessionDir);
		const defaultDir = resolvePath(getDefaultSessionDirPath(this.cwd));

		// Case-insensitive
		return process.platform === "win32"
			? configured.toLowerCase() === defaultDir.toLowerCase()
			: configured === defaultDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	getSkippedLines(): number {
		return this.skippedLines;
	}

	private _hasConversation(entries: FileEntry[] = this.fileEntries): boolean {
		return entries.some(
			(e) =>
				e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
		);
	}

	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		if (!this.flushed) {
			if (!this._hasConversation()) return;

			this._writeAllEntries();
			return;
		}

		if (!this.appendRecoveryNeeded) {
			if (existsSync(this.sessionFile)) {
				try {
					appendSessionLine(this.sessionFile, `${serializeSessionFileEntry(entry)}\n`);
					return;
				} catch {
					this.appendRecoveryNeeded = true;
				}
			} else {
				this.appendRecoveryNeeded = true;
			}
		}

		this._writeAllEntries();
	}

	_writeAllEntries(): void {
		try {
			this._rewriteFile();
		} catch (error) {
			this.persistFailure = true;
			throw error;
		}

		this.flushed = true;
		this.appendRecoveryNeeded = false;
		this.persistFailure = false;
	}

	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};

		this._appendEntry(entry);
		return entry.id;
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};

		this._appendEntry(entry);
		return entry.id;
	}

	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};

		this._appendEntry(entry);
		return entry.id;
	}

	appendUsage(
		kind: string,
		provider: string,
		model: string,
		usage: Usage,
		note?: string,
	): UsageEntry {
		const entry: UsageEntry = {
			type: "usage",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			kind,
			provider,
			model,
			usage,
			...(note ? { note } : {}),
		};

		this._appendEntry(entry);
		return entry;
	}

	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		const timestamp = new Date().toISOString();
		const systemMessage = getCurrentSystemMessage(this.buildSessionProjection().messages);
		const id = generateId(this.byId);

		const entry: CompactionEntry<T> = {
			type: "compaction",
			id,
			parentId: this.leafId,
			timestamp,
			summary,
			firstKeptEntryId: firstKeptEntryId ?? id,
			tokensBefore,
			details,
			usage,
			fromHook,
			...(systemMessage
				? { systemMessage: { ...systemMessage, timestamp: new Date(timestamp).getTime() } }
				: {}),
		};

		this._appendEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};

		this._appendEntry(entry);
		return entry.id;
	}

	appendSessionInfo(name: string): string {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();

		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};

		this._appendEntry(entry);
		return entry.id;
	}

	getSessionName(): string | undefined {
		const branch = this.getBranch();

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];

			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}

		return undefined;
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};

		this._appendEntry(entry);
		return entry.id;
	}

	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string {
		if (!isValidReplacement(replacement)) {
			throw new Error("Invalid replacement");
		}

		const target = this.byId.get(targetId);

		if (!target) throw new Error(`Entry not found: ${targetId}`);

		if (!this.getBranch().some((entry) => entry.id === targetId)) {
			throw new Error(`Entry off branch: ${targetId}`);
		}

		if (!isEditableEntry(target)) {
			throw new Error(`Entry not editable: ${targetId}`);
		}

		const targetRole = target.type === "message" ? target.message.role : "custom";
		const needsBlocks =
			replacement !== null &&
			(targetRole === "assistant" || targetRole === "toolResult") &&
			typeof replacement.content === "string";

		const normalizedReplacement = needsBlocks
			? { content: [{ type: "text" as const, text: replacement.content as string }] }
			: replacement;

		const entry: ContextEditEntry = {
			type: "context_edit",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			replacement: normalizedReplacement,
		};

		this._appendEntry(entry);
		return entry.id;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		return [...this.byId.values()].filter((entry) => entry.parentId === parentId);
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry not found: ${targetId}`);
		}

		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};

		this._appendEntry(entry);

		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}

		return entry.id;
	}

	getBranch(fromId?: string): SessionEntry[] {
		return walkBranch(this.byId, fromId ?? this.leafId);
	}

	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	buildSessionProjection(): SessionProjection {
		return buildSessionProjection(this.getEntries(), this.leafId, this.byId);
	}

	buildSessionContext(): SessionContext {
		const { messages, thinkingLevel, model } = this.buildSessionProjection();

		return { messages, thinkingLevel, model };
	}

	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");

		return h ? (h as SessionHeader) : null;
	}

	getEntryCount(): number {
		return this.byId.size;
	}

	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	getTree(): SessionTreeNode[] {
		return buildSessionTree(this.getEntries(), this.labelsById, this.labelTimestampsById);
	}

	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry not found: ${branchFromId}`);
		}

		this.leafId = branchFromId;
	}

	resetLeaf(): void {
		this.leafId = null;
	}

	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry not found: ${branchFromId}`);
		}

		const fromId = this.leafId ?? "root";
		this.leafId = branchFromId;

		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
			usage,
			fromHook,
		};

		this._appendEntry(entry);
		return entry.id;
	}

	// Label remap
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);

		if (path.length === 0) {
			throw new Error(`Entry not found: ${leafId}`);
		}

		const pathWithoutLabels: SessionEntry[] = [];
		const replacementByLabelId = new Map<string, string>();
		const pendingLabelIds: string[] = [];
		let pathParentId: string | null = null;

		for (const entry of path) {
			if (entry.type === "label") {
				pendingLabelIds.push(entry.id);
				continue;
			}

			for (const labelId of pendingLabelIds) {
				replacementByLabelId.set(labelId, entry.id);
			}

			pendingLabelIds.length = 0;
			pathWithoutLabels.push(retargetEntry(entry, pathParentId, replacementByLabelId));
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const newSessionFile = join(this.getSessionDir(), `${newSessionId}${SESSION_FILE_EXTENSION}`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];

		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({
					targetId,
					label,
					timestamp: this.labelTimestampsById.get(targetId)!,
				});
			}
		}

		const lastPathId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id ?? null;
		const labelEntries = createLabelEntries(labelsToWrite, lastPathId, pathEntryIds);
		const entries = [header, ...pathWithoutLabels, ...labelEntries];
		const hasConversation = this._hasConversation(entries);

		if (this.persist && hasConversation) {
			// Write first
			this._writeFile(newSessionFile, entries);
		}

		// Commit identity
		this.fileEntries = entries;
		this.sessionId = newSessionId;
		if (this.persist) this.sessionFile = newSessionFile;

		this._buildIndex();
		this.flushed = this.persist && hasConversation;

		return this.persist ? newSessionFile : undefined;
	}

	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionStore {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);

		return new SessionStore(cwd, dir, undefined, true, options);
	}

	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionStore {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;

		if (cwdOverride === undefined && existsSync(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;

				preloadedFileEntries = loadEntriesFromFile(resolvedPath);

				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}

		const cwd =
			cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");

		return new SessionStore(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries);
	}

	static continueRecent(cwd: string, sessionDir?: string): SessionStore {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);

		// Filter cwd
		const mostRecent = findMostRecentSession(dir, cwd);

		if (mostRecent) {
			return new SessionStore(cwd, dir, mostRecent, true);
		}

		return new SessionStore(cwd, dir, undefined, true);
	}

	static inMemory(
		cwd: string = process.cwd(),
		options?: NewSessionOptions,
		entries?: FileEntry[],
	): SessionStore {
		return new SessionStore(cwd, "", undefined, false, options, entries);
	}

	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionStore {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);

		if (sourceEntries.length === 0) {
			throw new Error(`Invalid source session: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as
			| SessionHeader
			| undefined;

		if (!sourceHeader) {
			throw new Error(`Missing source header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);

		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: SESSION_DIR_MODE });
		}

		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}

		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const newSessionFile = join(dir, `${newSessionId}${SESSION_FILE_EXTENSION}`);

		if (options?.id !== undefined) assertSessionFileFree(newSessionFile, newSessionId);

		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};

		migrateSessionEntries(sourceEntries);

		const sourceEntryLines = sourceEntries
			.filter((sourceEntry) => sourceEntry.type !== "session")
			.map((entry) => `${serializeSessionFileEntry(entry)}\n`);

		writeSessionFileAtomically(newSessionFile, [
			`${serializeSessionFileEntry(newHeader)}\n`,
			...sourceEntryLines,
		]);

		return new SessionStore(resolvedTargetCwd, dir, newSessionFile, true);
	}

	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const resolvedCwd = resolvePath(cwd);

		try {
			for (const file of readdirSync(dir)) {
				if (!isSessionFileName(file)) continue;

				const path = join(dir, file);
				const header = readSessionHeaderForDiscovery(path);

				if (header?.id !== id) continue;
				if (!sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) continue;

				return path;
			}
		} catch {}

		return undefined;
	}

	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const resolvedCwd = resolvePath(cwd);
		const includeSession = (session: SessionInfo) => sessionCwdMatches(session.cwd, resolvedCwd);

		const progress: SessionListProgress | undefined = onProgress
			? (loaded, total, partialSessions) =>
					onProgress(loaded, total, partialSessions?.filter(includeSession))
			: undefined;
		const sessions = (await listSessionsFromDir(dir, progress, signal)).filter(includeSession);

		return sortSessionInfos(sessions);
	}

	static async listAll(
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;

	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;

	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgressOrSignal?: SessionListProgress | AbortSignal,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string"
				? normalizePath(sessionDirOrOnProgress)
				: undefined;

		const progress =
			typeof sessionDirOrOnProgress === "function"
				? sessionDirOrOnProgress
				: typeof onProgressOrSignal === "function"
					? onProgressOrSignal
					: undefined;

		const abortSignal =
			typeof sessionDirOrOnProgress === "string" || typeof onProgressOrSignal === "function"
				? signal
				: (onProgressOrSignal ?? signal);

		abortSignal?.throwIfAborted();

		if (customSessionDir) {
			return sortSessionInfos(await listSessionsFromDir(customSessionDir, progress, abortSignal));
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) return [];

			const entries = await readdir(sessionsDir, { withFileTypes: true });
			const flatFiles = entries
				.filter((entry) => !entry.isDirectory() && isSessionFileName(entry.name))
				.map((entry) => join(sessionsDir, entry.name));
			const dirs = entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(sessionsDir, entry.name));

			const dirFiles = await mapWithConcurrency(
				dirs,
				MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
				async (dir) => {
					try {
						return (await readdir(dir))
							.filter((file) => isSessionFileName(file))
							.map((file) => join(dir, file));
					} catch {
						return [];
					}
				},
				abortSignal,
			);

			const allFiles = [...flatFiles, ...dirFiles.flat()];

			const candidates = await mapWithConcurrency(
				allFiles,
				MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
				async (path): Promise<SessionFileCandidate> => {
					try {
						return { path, stats: await stat(path) };
					} catch {
						return { path };
					}
				},
				abortSignal,
			);

			candidates.sort(
				(a, b) =>
					(b.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) -
						(a.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) ||
					basename(b.path).localeCompare(basename(a.path)),
			);

			const totalFiles = candidates.length;
			let loaded = 0;
			let firstCandidateLoaded = false;
			const partialSessions: SessionInfo[] = [];

			const results = await buildSessionInfosWithConcurrency(
				candidates,
				(info, index) => {
					loaded++;

					if (index === 0) firstCandidateLoaded = true;
					if (info) partialSessions.push(info);

					const publishPartial =
						firstCandidateLoaded &&
						(index === 0 ||
							loaded % ALL_SESSION_LIST_PUBLISH_INTERVAL === 0 ||
							loaded === totalFiles);

					progress?.(
						loaded,
						totalFiles,
						publishPartial ? sortSessionInfos([...partialSessions]) : undefined,
					);
				},
				abortSignal,
			);

			return sortSessionInfos(results.filter((info): info is SessionInfo => info !== null));
		} catch {
			abortSignal?.throwIfAborted();
			return [];
		}
	}
}
