import type { AgentMessage, AgentTool } from "@huranth/gama-agent-core";
import { toToolDeclaration } from "@huranth/gama-ai";
import {
	type AssistantMessage,
	isContextOverflow,
	isRecoverableLength,
	type Model,
} from "@huranth/gama-ai/compat";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	estimateContextTokens,
	estimateProjectedContextTokens,
	prepareCompaction,
	type SummarizationLineage,
	shouldCompact,
} from "../comp/index.ts";
import {
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionProjection,
} from "../sessions.ts";
import type { SessionEvent } from "./events.ts";

export interface LineageContext {
	messages: AgentMessage[];
	tools: AgentTool[];
}

export class CompactionCancelled extends Error {
	constructor() {
		super("Compaction cancelled");
	}
}

export function buildSummarizationLineage(
	context: LineageContext,
	preparation: CompactionPreparation,
): SummarizationLineage | undefined {
	const head = context.messages[0];
	if (!head || head.role !== "system") return undefined;

	const tools = context.tools.map(toToolDeclaration);
	return {
		messages: [head, ...preparation.messagesToSummarize],
		...(tools.length > 0 ? { tools } : {}),
	};
}

export function prepareManualCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation {
	const preparation = prepareCompaction(pathEntries, settings);
	if (preparation) return preparation;

	const lastEntry = pathEntries[pathEntries.length - 1];
	if (lastEntry?.type === "compaction") throw new Error("Already compacted");
	throw new Error("Session too small");
}

export function assertCompactionResult(
	result: CompactionResult,
	branch: readonly SessionEntry[],
): void {
	if (!result.summary.trim()) throw new Error("Empty summary");
	if (!Number.isFinite(result.tokensBefore) || result.tokensBefore < 0) {
		throw new Error(`Invalid token count: ${String(result.tokensBefore)}`);
	}

	const firstKeptEntryId = result.firstKeptEntryId ?? null;
	if (firstKeptEntryId !== null && !branch.some((entry) => entry.id === firstKeptEntryId)) {
		throw new Error(`Entry off branch: ${firstKeptEntryId}`);
	}
}

export function isCompactionAborted(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || error instanceof CompactionCancelled;
}

export function autoCompactionErrorMessage(
	reason: "overflow" | "threshold",
	message: string,
): string {
	return reason === "overflow"
		? `Context overflow recovery failed: ${message}`
		: `Auto-compaction failed: ${message}`;
}

export interface CompactionCheckContext {
	getModel(): Model<any> | undefined;
	getSettings(): CompactionSettings;
	getAgentMessages(): AgentMessage[];
	getBranch(): SessionEntry[];
	getProjection(): SessionProjection;
	modelForMessage(message: AssistantMessage): Model<any> | undefined;
	findMessageEntryId(message: AgentMessage): string | undefined;
	getOverflowRecoveryAttempted(): boolean;
	setOverflowRecoveryAttempted(value: boolean): void;
	omitRecoveryAttempt(message: AssistantMessage, toolResults?: AgentMessage[]): void;
	setFailedResponse(message: AssistantMessage): void;
	runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean>;
	emitCompactionEnd(event: CompactionEndEvent): void;
	emitSessionCompactFailed(event: CompactionFailedEvent): Promise<void>;
}

export type CompactionEndReason = "manual" | "threshold" | "overflow";

export type CompactionEndEvent = Extract<SessionEvent, { type: "compaction_end" }>;

export interface CompactionFailedEvent {
	reason: CompactionEndReason;
	errorMessage: string | undefined;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
}

export async function checkCompaction(
	context: CompactionCheckContext,
	assistantMessage: AssistantMessage,
	skipAbortedCheck = true,
	toolResults: AgentMessage[] = [],
): Promise<boolean> {
	const settings = context.getSettings();
	if (!settings.enabled) return false;

	if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

	const messageModel = context.modelForMessage(assistantMessage);
	const sameModel = messageModel !== undefined;
	const contextWindow = (messageModel ?? context.getModel())?.contextWindow ?? 0;

	const compactionEntry = getLatestCompactionEntry(context.getBranch());
	const assistantIsFromBeforeCompaction =
		compactionEntry !== null &&
		assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompaction) {
		return false;
	}

	const currentProjection = context.getProjection();
	const assistantEntryId = context.findMessageEntryId(assistantMessage);
	const assistantIsProjected =
		assistantEntryId === undefined ||
		currentProjection.entries.some(
			(entry) =>
				entry.sourceEntry.id === assistantEntryId &&
				entry.messages.some((message) => message.role === "assistant"),
		);
	const branch = context.getBranch();
	const assistantIndex = assistantEntryId
		? branch.findIndex((entry) => entry.id === assistantEntryId)
		: -1;
	const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
	const hasPostAssistantContextEdit = entriesAfterAssistant.some(
		(entry) => entry.type === "context_edit",
	);
	const latestAssistantEdit = entriesAfterAssistant
		.filter(
			(entry): entry is ContextEditEntry =>
				entry.type === "context_edit" && entry.targetId === assistantEntryId,
		)
		.at(-1);
	const assistantRetainedForExplicitRecovery =
		assistantEntryId === undefined ||
		(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
			latestAssistantEdit?.replacement !== null);
	const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
	const explicitOverflow =
		assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
	const contextOverflow =
		sameModel &&
		((explicitOverflow && assistantRetainedForExplicitRecovery) ||
			(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
	const recoverableLength =
		sameModel &&
		assistantIsProjected &&
		isRecoverableLength(assistantMessage, messageModel.maxTokens);

	if (contextOverflow || recoverableLength) {
		const willRetry = assistantMessage.stopReason !== "stop";

		if (!willRetry) {
			return await context.runAutoCompaction("overflow", false);
		}

		if (context.getOverflowRecoveryAttempted()) {
			const errorMessage = contextOverflow
				? "Context overflow recovery failed after one compact-and-retry attempt. " +
					"Try reducing context or switching to a larger-context model."
				: "Truncated response recovery failed after one compact-and-retry attempt.";
			context.emitCompactionEnd({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage,
			});
			await context.emitSessionCompactFailed({
				reason: "overflow",
				errorMessage,
				aborted: false,
				willRetry: false,
				fromExtension: false,
			});
			return false;
		}

		context.setOverflowRecoveryAttempted(true);
		context.omitRecoveryAttempt(assistantMessage, toolResults);
		const retry = await context.runAutoCompaction("overflow", willRetry);
		if (retry) context.setFailedResponse(assistantMessage);
		return retry;
	}

	let contextTokens: number;
	const projection = currentProjection;
	const hasContextEdits = projection.entries.some(
		(entry) => entry.sourceEntry.type === "context_edit",
	);
	const directContextTokens = assistantMessage.usage
		? calculateContextTokens(assistantMessage.usage)
		: 0;
	if (hasContextEdits) {
		contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
	} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
		const messages = context.getAgentMessages();
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex !== null) {
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <=
					new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
		}
		contextTokens = estimate.tokens;
	} else {
		contextTokens = directContextTokens;
	}
	if (shouldCompact(contextTokens, contextWindow, settings)) {
		return await context.runAutoCompaction("threshold", false);
	}
	return false;
}
