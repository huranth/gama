import {
	chmodSync,
	closeSync,
	createReadStream,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmdirSync,
	type Stats,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentMessage } from "@huranth/gama-agent-core";
import type { Message, TextContent } from "@huranth/gama-ai";
import { getAgentDir as getDefaultAgentDir } from "../../config.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import {
	getSessionHeaderCwd,
	loadEntriesFromFile,
	parseSessionEntryLine,
	readSessionHeaderForDiscovery,
	sessionCwdMatches,
} from "../session-file.ts";
import type { SessionHeader, SessionMessageEntry } from "./entries.ts";
import { serializeSessionFileEntry } from "./entries.ts";

export const SESSION_FILE_EXTENSION = ".gama";

const LEGACY_SESSION_FILE_EXTENSION = ".jsonl";

// Filename limit
const MAX_SESSION_ID_LENGTH = 200;

const WINDOWS_RESERVED_SESSION_ID = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i;

export const SESSION_FILE_MODE = 0o600;

export const SESSION_DIR_MODE = 0o700;

export const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

export const MAX_CONCURRENT_SESSION_DISCOVERY_LOADS = 64;

export const CURRENT_SESSION_LIST_PUBLISH_INTERVAL = 10;

export const ALL_SESSION_LIST_PUBLISH_INTERVAL = 100;

export const RETRY_RENAME_DELAY_MS = 50;

export const RENAME_ATTEMPTS = 2;

export interface SessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (
	loaded: number,
	total: number,
	partialSessions?: readonly SessionInfo[],
) => void;

export interface SessionFileCandidate {
	path: string;
	stats?: Stats;
}

export function isSessionFileName(fileName: string): boolean {
	return (
		fileName.endsWith(SESSION_FILE_EXTENSION) || fileName.endsWith(LEGACY_SESSION_FILE_EXTENSION)
	);
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error("Invalid session id");
	}

	if (WINDOWS_RESERVED_SESSION_ID.test(id)) {
		throw new Error(`Reserved session id: ${id}`);
	}

	if (id.length > MAX_SESSION_ID_LENGTH) {
		throw new Error(`Long session id: ${MAX_SESSION_ID_LENGTH}`);
	}
}

export function getDefaultSessionDirPath(
	_cwd: string,
	agentDir: string = getDefaultAgentDir(),
): string {
	return join(resolvePath(agentDir), "sessions");
}

function legacySessionDirPath(cwd: string, agentDir: string): string {
	const resolvedCwd = resolvePath(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

	return join(resolvePath(agentDir), "sessions", safePath);
}

function removeQuietly(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {}
}

export function assertSessionFileFree(filePath: string, _id: string): void {
	if (existsSync(filePath)) {
		throw new Error(`Session exists: ${filePath}`);
	}
}

export function enforceSessionFileMode(filePath: string): void {
	if (process.platform === "win32") return;

	try {
		chmodSync(filePath, SESSION_FILE_MODE);
	} catch {}
}

const NEWLINE = "\n";

const NEWLINE_BYTE = 0x0a;

function missingTrailingNewline(filePath: string): boolean {
	if (!existsSync(filePath)) return false;

	const fd = openSync(filePath, "r");

	try {
		const size = fstatSync(fd).size;
		if (size === 0) return false;

		const last = Buffer.allocUnsafe(1);
		readSync(fd, last, 0, 1, size - 1);

		return last[0] !== NEWLINE_BYTE;
	} finally {
		closeSync(fd);
	}
}

export function appendSessionLine(filePath: string, line: string): void {
	// Torn line.
	const prefix = missingTrailingNewline(filePath) ? NEWLINE : "";
	const fd = openSync(filePath, "a", SESSION_FILE_MODE);

	try {
		writeFileSync(fd, `${prefix}${line}`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function writeSessionFileAtomically(filePath: string, lines: string[]): void {
	const tempPath = join(
		dirname(filePath),
		`.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
	);
	const fd = openSync(tempPath, "wx", SESSION_FILE_MODE);

	try {
		try {
			for (const line of lines) {
				writeFileSync(fd, line);
			}

			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		removeQuietly(tempPath);
		throw error;
	}

	try {
		renameSync(tempPath, filePath);
	} catch (error) {
		removeQuietly(tempPath);
		throw error;
	}

	if (process.platform !== "win32") {
		let dirFd: number | undefined;

		try {
			dirFd = openSync(dirname(filePath), "r");
			fsyncSync(dirFd);
		} catch {
			// Fsync
		} finally {
			if (dirFd !== undefined) closeSync(dirFd);
		}
	}
}

function migrateLegacySessionDir(cwd: string, agentDir: string): void {
	const legacyDir = legacySessionDirPath(cwd, agentDir);

	if (!existsSync(legacyDir)) return;

	const targetDir = getDefaultSessionDirPath(cwd, agentDir);

	try {
		mkdirSync(targetDir, { recursive: true, mode: SESSION_DIR_MODE });

		for (const file of readdirSync(legacyDir)) {
			if (!isSessionFileName(file)) continue;

			const sourcePath = join(legacyDir, file);

			try {
				const entries = loadEntriesFromFile(sourcePath);
				const header = entries.find((entry) => entry.type === "session");

				if (!header) continue;

				// Trusted ids
				try {
					assertValidSessionId(header.id);
				} catch {
					continue;
				}

				const targetPath = join(targetDir, `${header.id}${SESSION_FILE_EXTENSION}`);
				const targetHeader = existsSync(targetPath)
					? readSessionHeaderForDiscovery(targetPath)
					: null;
				const targetValid = targetHeader?.id === header.id;
				const serialized = entries
					.map((entry) => `${serializeSessionFileEntry(entry)}\n`)
					.join("");

				if (!targetValid) {
					writeSessionFileAtomically(targetPath, [serialized]);
				} else {
					// Keep source.
					const targetEntries = loadEntriesFromFile(targetPath);
					const targetSerialized = targetEntries
						.map((entry) => `${serializeSessionFileEntry(entry)}\n`)
						.join("");
					if (targetSerialized !== serialized) continue;
				}

				unlinkSync(sourcePath);
			} catch {}
		}

		if (readdirSync(legacyDir).length === 0) rmdirSync(legacyDir);
	} catch {}
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);

	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true, mode: SESSION_DIR_MODE });
	}

	migrateLegacySessionDir(cwd, agentDir);
	return sessionDir;
}

export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;

	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((file) => isSessionFileName(file))
			.map((file) => join(resolvedSessionDir, file))
			.flatMap((path) => {
				try {
					return [{ path, mtime: statSync(path).mtimeMs }];
				} catch {
					return [];
				}
			})
			.sort((a, b) => b.mtime - a.mtime);

		for (const { path } of files) {
			const header = readSessionHeaderForDiscovery(path);

			if (!header) continue;

			const cwdMatches =
				!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd);

			if (cwdMatches) return path;
		}

		return null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;

	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;

	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;

	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	map: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		while (nextIndex < items.length) {
			signal?.throwIfAborted();

			const index = nextIndex++;
			results[index] = await map(items[index]!, index);
		}
	};

	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);

	return results;
}

async function buildSessionInfo(
	filePath: string,
	signal?: AbortSignal,
	fileStats?: Stats,
): Promise<SessionInfo | null> {
	try {
		const stats = fileStats ?? (await stat(filePath));
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const stream = createReadStream(filePath, { encoding: "utf8", signal });
		const rl = createInterface({ input: stream, crlfDelay: Infinity });

		try {
			for await (const line of rl) {
				const entry = parseSessionEntryLine(line);

				if (!entry) continue;

				if (!header) {
					if (entry.type !== "session") return null;
					header = entry;
					continue;
				}

				if (entry.type === "session_info") {
					name = entry.name?.trim() || undefined;
				}

				if (entry.type !== "message") continue;
				messageCount++;

				const activityTime = getMessageActivityTime(entry);

				if (typeof activityTime === "number") {
					lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
				}

				const message = entry.message;

				if (!isMessageWithContent(message)) continue;
				if (message.role !== "user" && message.role !== "assistant") continue;

				const textContent = extractTextContent(message);

				if (!textContent) continue;

				allMessages.push(textContent);

				if (!firstMessage && message.role === "user") {
					firstMessage = textContent;
				}
			}
		} finally {
			rl.close();
			stream.destroy();
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime =
			typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;

		let modified = stats.mtime;

		if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
			modified = new Date(lastActivityTime);
		} else if (!Number.isNaN(headerTime)) {
			modified = new Date(headerTime);
		}

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

export function sortSessionInfos(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function buildSessionInfosWithConcurrency(
	files: SessionFileCandidate[],
	onLoaded: (info: SessionInfo | null, index: number) => void,
	signal?: AbortSignal,
): Promise<(SessionInfo | null)[]> {
	return mapWithConcurrency(
		files,
		MAX_CONCURRENT_SESSION_INFO_LOADS,
		async (file, index) => {
			const info = await buildSessionInfo(file.path, signal, file.stats);
			onLoaded(info, index);
			return info;
		},
		signal,
	);
}

export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	signal?.throwIfAborted();

	if (!existsSync(dir)) return [];

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries
			.filter((file) => isSessionFileName(file))
			.sort((a, b) => b.localeCompare(a))
			.map((file) => ({ path: join(dir, file) }));
		const total = files.length;
		const partialSessions: SessionInfo[] = [];
		let loaded = 0;

		const results = await buildSessionInfosWithConcurrency(
			files,
			(info) => {
				loaded++;

				if (info) partialSessions.push(info);

				const publishPartial =
					loaded === 1 ||
					loaded % CURRENT_SESSION_LIST_PUBLISH_INTERVAL === 0 ||
					loaded === files.length;

				onProgress?.(
					loaded,
					total,
					publishPartial ? sortSessionInfos([...partialSessions]) : undefined,
				);
			},
			signal,
		);

		return results.filter((info): info is SessionInfo => info !== null);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}
