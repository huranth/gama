import type { AgentMessage } from "@huranth/gama-agent-core";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../msg.ts";
import type { CompactionEntry, ContextEditEntry, SessionEntry } from "./entries.ts";
import { buildSessionPath } from "./tree.ts";

export interface SessionProjection {
	entries: ProjectedSessionEntry[];
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
}

export interface ProjectedSessionEntry {
	sourceEntry: SessionEntry;
	messages: AgentMessage[];
}

function getSessionContextSettings(
	path: SessionEntry[],
): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;

		if (message.role === "system" && message.content == null) {
			return [{ ...message, content: "" }];
		}

		const isBlockContent =
			message.role === "user" || message.role === "assistant" || message.role === "toolResult";

		if (isBlockContent && message.content == null) {
			return [{ ...message, content: [] }];
		}

		return [message];
	}

	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				entry.content ?? [],
				entry.display,
				entry.details,
				entry.timestamp,
			),
		];
	}

	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}

	if (entry.type === "compaction") {
		const summary = createCompactionSummaryMessage(
			entry.summary,
			entry.tokensBefore,
			entry.timestamp,
		);

		return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
	}

	return [];
}

function projectContextEntry(
	entry: SessionEntry,
	edit: ContextEditEntry | undefined,
): AgentMessage[] {
	const messages = sessionEntryToContextMessages(entry);

	if (!edit) return messages;

	const replacement = edit.replacement;

	if (replacement === null) return [];

	return messages.map((message) => {
		const canEdit =
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult" ||
			message.role === "custom";

		if (!canEdit) return message;

		const replacementContent = replacement.content;
		const needsBlocks =
			(message.role === "assistant" || message.role === "toolResult") &&
			typeof replacementContent === "string";
		const content = needsBlocks
			? [{ type: "text" as const, text: replacementContent }]
			: replacementContent;

		return { ...message, content } as AgentMessage;
	});
}

export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);

	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;

	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];

		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}

		if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
			contextEntries.push(entry);
		}
	}

	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

export function buildSessionProjection(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionProjection {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const contextEntries = buildContextEntries(entries, leafId, byId);
	const edits = new Map<string, ContextEditEntry>();

	for (const entry of contextEntries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}

	const projectedEntries = contextEntries.map((sourceEntry, index): ProjectedSessionEntry => {
		const isKeptCompaction = sourceEntry.type === "compaction" && index > 0;
		const messages = isKeptCompaction
			? []
			: projectContextEntry(sourceEntry, edits.get(sourceEntry.id));

		return { sourceEntry, messages };
	});

	return {
		entries: projectedEntries,
		messages: projectedEntries.flatMap((entry) => entry.messages),
		thinkingLevel,
		model,
	};
}

export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const { messages, thinkingLevel, model } = buildSessionProjection(entries, leafId, byId);

	return { messages, thinkingLevel, model };
}
