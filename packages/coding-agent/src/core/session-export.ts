import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionHeader,
	type SessionManager,
	serializeSessionFileEntry,
} from "./session-manager.ts";

type TrailingEntries = (parentId: string | null, timestamp: string) => readonly object[];

export function serializeSessionBranch(
	sessionManager: SessionManager,
	createTrailingEntries?: TrailingEntries,
): string {
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const entries: object[] = [header];
	let parentId: string | null = null;

	for (const entry of sessionManager.getBranch()) {
		entries.push({ ...entry, parentId });
		parentId = entry.id;
	}

	entries.push(...(createTrailingEntries?.(parentId, timestamp) ?? []));
	return `${entries.map((entry) => serializeSessionFileEntry(entry as FileEntry)).join("\n")}\n`;
}

export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: TrailingEntries,
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);

	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	writeFileSync(filePath, serializeSessionBranch(sessionManager, createTrailingEntries));
	return filePath;
}
