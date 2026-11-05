import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@huranth/gama-agent-core";
import {
	type AssistantMessage,
	type ImageContent,
	type SystemMessage,
	type TextContent,
	type ToolResultMessage,
	type Usage,
	type UserMessage,
	uuidv7,
} from "@huranth/gama-ai";
import type { CustomMessage } from "../msg.ts";

export const CURRENT_SESSION_VERSION = 3;

// Id attempts
const ID_ATTEMPTS = 100;

const SHORT_ID_LENGTH = 8;

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: string;
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface UsageEntry extends SessionEntryBase {
	type: "usage";
	kind: string;
	provider: string;
	model: string;
	usage: Usage;
	note?: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
	systemMessage?: SystemMessage;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	usage?: Usage;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	name?: string;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type ContextEditableContent =
	| UserMessage["content"]
	| AssistantMessage["content"]
	| ToolResultMessage["content"]
	| CustomMessage["content"];

export interface ContextEditEntry extends SessionEntryBase {
	type: "context_edit";
	targetId: string;
	replacement: { content: ContextEditableContent } | null;
}

export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| UsageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| ContextEditEntry
	| LabelEntry
	| SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export function createSessionId(): string {
	return uuidv7();
}

export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < ID_ATTEMPTS; i++) {
		const id = randomUUID().slice(0, SHORT_ID_LENGTH);
		if (!byId.has(id)) return id;
	}

	return randomUUID();
}

export function serializeSessionFileEntry(entry: FileEntry): string {
	if (entry.type === "session") {
		// Legacy keys
		const diskHeader = {
			$gama: "session",
			type: "session",
			version: entry.version ?? CURRENT_SESSION_VERSION,
			id: entry.id,
			cwd: entry.cwd,
			timestamp: entry.timestamp,
			parentSession: entry.parentSession,
		};

		return JSON.stringify(diskHeader);
	}

	return JSON.stringify(entry);
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}

	return null;
}

function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		entry.id = generateId(ids);
		ids.add(entry.id);
		entry.parentId = prevId;
		prevId = entry.id;

		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };

			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];

				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}

				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;

			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

export function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}
