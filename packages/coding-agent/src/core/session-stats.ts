import type { AssistantMessage } from "@huranth/gama-ai/compat";
import type { CacheSnapshot } from "./cache/index.ts";
import { calculateContextTokens, estimateProjectedContextTokens } from "./comp/index.ts";
import type { ContextUsage } from "./ext/index.ts";
import {
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionProjection,
} from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "./usage-totals.ts";

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	cache: CacheSnapshot;
	contextUsage?: ContextUsage;
}

export interface SessionStatsInput {
	sessionFile: string | undefined;
	sessionId: string;
	cache: CacheSnapshot;
	contextUsage?: ContextUsage;
}

interface MessageCounts {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
}

export function computeSessionStats(
	entries: readonly SessionEntry[],
	input: SessionStatsInput,
): SessionStats {
	const totals = createUsageTotals();
	const counts = countMessages(entries, totals);

	return {
		sessionFile: input.sessionFile,
		sessionId: input.sessionId,
		...counts,
		tokens: {
			input: totals.input,
			output: totals.output,
			cacheRead: totals.cacheRead,
			cacheWrite: totals.cacheWrite,
			total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		},
		cost: totals.cost,
		cache: input.cache,
		contextUsage: input.contextUsage,
	};
}

function countToolCalls(message: AssistantMessage): number {
	if (!Array.isArray(message.content)) return 0;
	return message.content.filter((block) => block.type === "toolCall").length;
}

export function computeContextUsage(
	contextWindow: number,
	projection: SessionProjection,
	branch: SessionEntry[],
): ContextUsage | undefined {
	if (contextWindow <= 0) return undefined;

	const latestCompaction = getLatestCompactionEntry(branch);
	if (latestCompaction && !hasUsageAfterCompaction(branch, projection, latestCompaction.id)) {
		return { tokens: null, contextWindow, percent: null };
	}

	const estimate = estimateProjectedContextTokens(projection, branch);
	return {
		tokens: estimate.tokens,
		contextWindow,
		percent: (estimate.tokens / contextWindow) * 100,
	};
}

function addEntryUsage(entry: SessionEntry, totals: UsageTotals): void {
	if (entry.type === "usage") {
		addUsageToTotals(totals, entry.usage);
		return;
	}
	const isSummary = entry.type === "branch_summary" || entry.type === "compaction";
	if (isSummary && entry.usage) addUsageToTotals(totals, entry.usage);
}

function hasUsageAfterCompaction(
	branch: SessionEntry[],
	projection: SessionProjection,
	compactionId: string,
): boolean {
	const measuredEntries = new Set<string>();
	for (const entry of projection.entries) {
		const measured = entry.messages.some((message) => {
			if (message.role !== "assistant") return false;
			if (message.stopReason === "aborted" || message.stopReason === "error") return false;
			return calculateContextTokens(message.usage) > 0;
		});
		if (measured) measuredEntries.add(entry.sourceEntry.id);
	}

	const compactionIndex = branch.findIndex((entry) => entry.id === compactionId);
	return branch.slice(compactionIndex + 1).some((entry) => measuredEntries.has(entry.id));
}

function countMessages(entries: readonly SessionEntry[], totals: UsageTotals): MessageCounts {
	const counts: MessageCounts = {
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
	};

	for (const entry of entries) {
		addEntryUsage(entry, totals);
		if (entry.type !== "message") continue;

		const message = entry.message;
		counts.totalMessages++;
		if (message.role === "user") {
			counts.userMessages++;
		} else if (message.role === "toolResult") {
			counts.toolResults++;
			if (message.usage) addUsageToTotals(totals, message.usage);
		} else if (message.role === "assistant") {
			counts.assistantMessages++;
			counts.toolCalls += countToolCalls(message);
			addUsageToTotals(totals, message.usage);
		}
	}

	return counts;
}
