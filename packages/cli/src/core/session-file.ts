import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION } from "./session/entries.ts";
import type { FileEntry, SessionHeader } from "./session/entries.ts";

const SESSION_READ_BYTES = 1024 * 1024;

const HEADER_READ_BYTES = 4 * 1024;

const MAX_HEADER_SCAN_BYTES = 1024 * 1024;

export class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string") return value;
	}

	return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number") return value;
	}

	return undefined;
}

export function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;

	try {
		const parsed: unknown = JSON.parse(line.trim());
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return null;
		}

		const value = parsed as Record<string, unknown>;
		if (value.$gama === "session" && typeof value.id === "string") {
			const rawVersion = firstNumber(value.version, value.format);
			const version =
				rawVersion !== undefined && Number.isSafeInteger(rawVersion) && rawVersion > 0
					? rawVersion
					: CURRENT_SESSION_VERSION;
			const timestamp =
				firstString(value.timestamp, value.createdAt) ?? new Date(0).toISOString();
			const parentSession = firstString(value.parentSession, value.parent);

			return {
				type: "session",
				version,
				id: value.id,
				cwd: typeof value.cwd === "string" ? value.cwd : "",
				timestamp,
				parentSession,
			};
		}

		if (typeof value.type !== "string") return null;

		return value as unknown as FileEntry;
	} catch {
		return null;
	}
}

export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];

	for (const line of content.split("\n")) {
		const entry = parseSessionEntryLine(line);

		if (entry) entries.push(entry);
	}

	return entries;
}

export interface SessionFileLoad {
	entries: FileEntry[];
	skipped: number;
}

export function loadSessionFile(filePath: string): SessionFileLoad {
	const resolvedFilePath = normalizePath(filePath);
	const state: SessionFileLoad = { entries: [], skipped: 0 };
	if (!existsSync(resolvedFilePath)) return state;

	const { entries } = state;
	const fd = openSync(resolvedFilePath, "r");
	let pending = "";

	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BYTES);

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));

			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);

			while (newlineIndex !== -1) {
				const line = pending.slice(lineStart, newlineIndex);
				const entry = parseSessionEntryLine(line);

				if (entry) entries.push(entry);
				else if (line.trim()) state.skipped++;

				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}

			pending = pending.slice(lineStart);
		}

		pending += decoder.end();

		const finalEntry = parseSessionEntryLine(pending);

		if (finalEntry) entries.push(finalEntry);
		else if (pending.trim()) state.skipped++;
	} finally {
		closeSync(fd);
	}

	if (entries.length === 0) return state;

	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return { entries: [], skipped: state.skipped };
	}

	return state;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	return loadSessionFile(filePath).entries;
}

function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;

	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session") return null;
	if (typeof (entry as { id?: unknown }).id !== "string") return null;

	return entry;
}

export function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES);
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		while (scannedBytes < MAX_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));

			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);

			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));

				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				if (header !== undefined) return header;

				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}

			lineChunks.push(chunk.slice(lineStart));
		}

		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

export function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		return null;
	}
}

export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;

	return typeof cwd === "string" ? cwd : undefined;
}

function samePath(left: string, right: string): boolean {
	if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();

	return left === right;
}

export function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	if (cwd === undefined || cwd === "") return false;

	return samePath(resolvePath(cwd), resolvedCwd);
}
