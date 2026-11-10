import type { AssistantMessage } from "@huranth/gama-ai/compat";
import { Spacer } from "@huranth/gama-tui";
import { createCompactionSummaryMessage, createCustomMessage } from "../core/msg.ts";
import { formatNotice } from "../core/notices.ts";
import type { SessionEvent } from "../core/session/session.ts";
import type { TermApp } from "./app.ts";
import { hasAssistantToolCalls } from "./chat.ts";
import {
	AssistantMessageComponent,
	hasVisibleAssistantContent,
} from "./parts/assistant-message.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
} from "./parts/status-indicator.ts";
import { ThemedText } from "./parts/themed-text.ts";
import { theme } from "./theme/theme.ts";

// Event slice
export type AgentEventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

// Bell delay
const TURN_NOTIFY_MIN_MS = 20_000;

export function handleAgentStart(mode: TermApp): void {
	// Time run
	mode.agentRunStartedAt ??= Date.now();
	mode.pendingToolCalls.clear();
	mode.clearStatusIndicator("retry");
	if (mode.retryEscapeHandler) {
		mode.defaultEditor.onEscape = mode.retryEscapeHandler;
		mode.retryEscapeHandler = undefined;
	}
}

export function handleTurnStart(mode: TermApp): void {
	if (mode.settingsManager.getShowTerminalProgress()) {
		mode.ui.terminal.setProgress(true);
	}
	if (mode.workingVisible) {
		if (mode.activeStatusIndicator?.kind !== "working") {
			mode.showWorkingStatusIndicator();
		}
	} else {
		mode.clearStatusIndicator();
	}
	mode.ui.requestRender();
}

export function handleQueueUpdate(mode: TermApp): void {
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
}

export function handleSessionInfoChanged(mode: TermApp): void {
	mode.updateTerminalTitle();
	mode.footer.invalidate();
	mode.ui.requestRender();
}

export function handleThinkingLevelChanged(mode: TermApp): void {
	mode.refreshModelIndicators();
}

export function estimateStreamingOutputTokens(message: AssistantMessage): number {
	let chars = 0;

	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
	}

	return Math.ceil(chars / 4);
}

export function maybeWarnAboutCacheCold(mode: TermApp, isAssistant: boolean): void {
	if (!isAssistant || mode.cacheColdWarningShown) return;
	const health = mode.session.cacheHealth();
	if (health.status !== "cold" || !health.message) return;
	mode.cacheColdWarningShown = true;
	mode.showWarning(health.message);
}

export function handleMessageStart(mode: TermApp, event: AgentEventOf<"message_start">): void {
	if (event.message.role === "custom") {
		mode.addMessageToChat(event.message);
		mode.ui.requestRender();
	} else if (event.message.role === "user") {
		mode.addMessageToChat(event.message);
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
	} else if (event.message.role === "assistant") {
		mode.streamingComponent = new AssistantMessageComponent(
			undefined,
			mode.hideThinkingBlock,
			mode.getMarkdownThemeWithSettings(),
			mode.hiddenThinkingLabel,
			mode.outputPad,
			mode.getMarkdownTransformers(),
			() => mode.ui.requestRender(),
			() => mode.toggleThinkingBlockVisibility(),
		);
		mode.streamingMessage = event.message;
		mode.footer.setStreamingUsage(
			event.message.usage,
			mode.estimateStreamingOutputTokens(event.message),
		);
		mode.streamingSpacer = mode.addChatChild(mode.streamingComponent);
		mode.streamingComponent.updateContent(event.message, true);
		mode.ui.requestRender();
	}
}

export function handleMessageUpdate(mode: TermApp, event: AgentEventOf<"message_update">): void {
	if (mode.streamingComponent && event.message.role === "assistant") {
		mode.streamingMessage = event.message;
		mode.footer.setStreamingUsage(
			event.message.usage,
			mode.estimateStreamingOutputTokens(event.message),
		);
		mode.streamingComponent.updateContent(event.message, true);

		for (const content of event.message.content) {
			if (content.type === "toolCall") {
				if (!mode.activityByToolId.has(content.id)) {
					mode.trackActivity(content.id, content.name, content.arguments);
				} else {
					// Update args
					mode.updateActivity(content.id, { args: content.arguments });
				}
				if (!mode.isSilentTool(content.name)) mode.pendingToolCalls.add(content.id);
			}
		}
		mode.ui.requestRender();
	}
}

export function handleMessageEnd(mode: TermApp, event: AgentEventOf<"message_end">): void {
	if (event.message.role === "user") return;
	if (mode.streamingComponent && event.message.role === "assistant") {
		const message = event.message;
		mode.streamingMessage = message;
		let errorMessage: string | undefined;
		if (message.stopReason === "aborted") {
			const retryAttempt = mode.session.retryAttempt;
			errorMessage = retryAttempt > 0 ? `Aborted: ${retryAttempt}` : "Aborted";
			message.errorMessage = errorMessage;
		}
		mode.streamingComponent.updateContent(message, false);
		if (
			hasAssistantToolCalls(message) &&
			!hasVisibleAssistantContent(message) &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			mode.dropChatChild(mode.streamingComponent, mode.streamingSpacer);
		}

		if (message.stopReason === "aborted" || message.stopReason === "error") {
			if (!errorMessage) {
				errorMessage = message.errorMessage || "Error";
			}
			mode.settleRunningActivities(errorMessage);
			mode.pendingToolCalls.clear();
		} else {
			mode.maybeShowThinkingDropNotice(message);
		}
		mode.streamingComponent = undefined;
		mode.streamingMessage = undefined;
		mode.streamingSpacer = null;
		mode.footer.clearStreamingUsage();
		mode.footer.invalidate();
	}
	mode.maybeWarnAboutCacheCold(event.message.role === "assistant");
	mode.ui.requestRender();
}

export function handleEntryAppended(mode: TermApp, event: AgentEventOf<"entry_appended">): void {
	if (mode.entriesRenderedByBoundaryCompaction.delete(event.entry.id)) return;
	if (event.entry.type === "custom") {
		mode.addCustomEntryToChat(event.entry);
		mode.ui.requestRender();
	} else if (event.entry.type === "custom_message" && event.entry.display) {
		mode.addMessageToChat(
			createCustomMessage(
				event.entry.customType,
				event.entry.content,
				event.entry.display,
				event.entry.details,
				event.entry.timestamp,
			),
		);
		mode.ui.requestRender();
	} else if (event.entry.type === "compaction") {
		const entries = mode.sessionManager.buildContextEntries();
		if (entries[0]?.id !== event.entry.id) return;
		mode.resetActivity();
		mode.chatContainer.clear();
		const branch = mode.sessionManager.getBranch();
		const compactionIndex = branch.findIndex((entry) => entry.id === event.entry.id);
		const entriesAfterCompaction = new Set(
			branch.slice(compactionIndex + 1).map((entry) => entry.id),
		);
		const retainedEntries = entries.slice(1);
		mode.renderSessionEntries(
			retainedEntries.filter((entry) => !entriesAfterCompaction.has(entry.id)),
		);
		mode.addMessageToChat(
			createCompactionSummaryMessage(
				event.entry.summary,
				event.entry.tokensBefore,
				event.entry.timestamp,
			),
		);
		if (event.entry.usage) {
			mode.addCompactionCostNotice({
				type: "compaction_cost",
				kind: "compaction",
				usage: event.entry.usage,
			});
		}
		mode.renderSessionEntries(
			retainedEntries.filter((entry) => entriesAfterCompaction.has(entry.id)),
		);
		for (const entryId of entriesAfterCompaction)
			mode.entriesRenderedByBoundaryCompaction.add(entryId);
		mode.footer.invalidate();
		mode.ui.requestRender();
	}
}

export function handleToolExecutionStart(
	mode: TermApp,
	event: AgentEventOf<"tool_execution_start">,
): void {
	if (event.parentToolCallId) return;
	if (!mode.activityByToolId.has(event.toolCallId)) {
		mode.trackActivity(event.toolCallId, event.toolName, event.args);
	}
	if (!mode.isSilentTool(event.toolName)) mode.pendingToolCalls.add(event.toolCallId);
	mode.updateActivity(event.toolCallId, { status: "running", args: event.args });
	mode.ui.requestRender();
}

export function handleToolExecutionUpdate(
	mode: TermApp,
	event: AgentEventOf<"tool_execution_update">,
): void {
	if (event.parentToolCallId) return;
	mode.updateActivity(event.toolCallId, {
		status: "running",
		result: { content: event.partialResult.content ?? [] },
	});
	mode.ui.requestRender();
}

export function handleToolExecutionEnd(
	mode: TermApp,
	event: AgentEventOf<"tool_execution_end">,
): void {
	if (event.parentToolCallId) return;
	// Fail closed
	const failed = event.isError === true || event.result.isError === true;
	mode.updateActivity(event.toolCallId, {
		status: failed ? "error" : "success",
		result: { content: event.result.content ?? [], details: event.result.details },
	});
	mode.pendingToolCalls.delete(event.toolCallId);
	mode.ui.requestRender();
}

export function handleAgentEnd(mode: TermApp, event: AgentEventOf<"agent_end">): void {
	const last = event.messages.at(-1);
	mode.agentRunAborted = last?.role === "assistant" && last.stopReason === "aborted";
	if (mode.settingsManager.getShowTerminalProgress()) {
		mode.ui.terminal.setProgress(false);
	}
	mode.clearStatusIndicator("working");
	if (mode.streamingComponent) {
		const leftover = mode.streamingMessage;
		const drop =
			!leftover ||
			(leftover.stopReason !== "aborted" &&
				leftover.stopReason !== "error" &&
				(hasAssistantToolCalls(leftover) || !hasVisibleAssistantContent(leftover)));
		if (drop) {
			mode.dropChatChild(mode.streamingComponent, mode.streamingSpacer);
		}
		mode.streamingComponent = undefined;
		mode.streamingMessage = undefined;
		mode.streamingSpacer = null;
	}
	mode.settleRunningActivities("Tool call skipped");
	mode.settleCurrentActivity();
	mode.pendingToolCalls.clear();

	mode.ui.requestRender();
}

export async function handleAgentSettled(mode: TermApp): Promise<void> {
	if (
		mode.agentRunStartedAt !== undefined &&
		!mode.agentRunAborted &&
		Date.now() - mode.agentRunStartedAt >= TURN_NOTIFY_MIN_MS &&
		mode.settingsManager.getNotifyOnTurnEnd()
	) {
		mode.ui.terminal.write("\x07");
	}
	mode.agentRunStartedAt = undefined;
	mode.agentRunAborted = false;
	await mode.checkShutdownRequested();
}

export function handleCompactionStart(
	mode: TermApp,
	event: AgentEventOf<"compaction_start">,
): void {
	if (mode.settingsManager.getShowTerminalProgress()) {
		mode.ui.terminal.setProgress(true);
	}
	mode.autoCompactionEscapeHandler = mode.defaultEditor.onEscape;
	mode.defaultEditor.onEscape = () => {
		mode.session.abortCompaction();
	};
	mode.showStatusIndicator(new CompactionStatusIndicator(mode.ui, event.reason));
	mode.ui.requestRender();
}

export function handleCompactionEnd(mode: TermApp, event: AgentEventOf<"compaction_end">): void {
	if (mode.settingsManager.getShowTerminalProgress()) {
		mode.ui.terminal.setProgress(false);
	}
	if (mode.autoCompactionEscapeHandler) {
		mode.defaultEditor.onEscape = mode.autoCompactionEscapeHandler;
		mode.autoCompactionEscapeHandler = undefined;
	}
	mode.clearStatusIndicator("compaction");
	if (event.aborted) {
		if (event.reason === "manual") {
			mode.showError("Compaction cancelled");
		} else {
			mode.showStatus("Compaction cancelled");
		}
	} else if (event.result) {
		const entries = mode.sessionManager.buildContextEntries();
		if (entries[0]?.type !== "compaction") {
			throw new Error("Missing compaction");
		}
		mode.resetActivity();
		mode.chatContainer.clear();
		mode.renderSessionEntries(entries.slice(1));
		mode.addMessageToChat(
			createCompactionSummaryMessage(
				event.result.summary,
				event.result.tokensBefore,
				new Date().toISOString(),
			),
		);
		if (event.result.usage) {
			mode.addCompactionCostNotice({
				type: "compaction_cost",
				kind: "compaction",
				usage: event.result.usage,
			});
		}
		mode.footer.invalidate();
	} else if (event.errorMessage) {
		if (event.reason === "manual") {
			mode.showError(event.errorMessage);
		} else {
			mode.chatContainer.addChild(new Spacer(1));
			const errorMessage = formatNotice(event.errorMessage);
			mode.chatContainer.addChild(new ThemedText(() => theme.fg("error", errorMessage), 1, 0));
		}
	}
	void mode.flushCompactionQueue({ willRetry: event.willRetry });
	mode.ui.requestRender();
}

export function handleAutoRetryStart(mode: TermApp, event: AgentEventOf<"auto_retry_start">): void {
	mode.retryEscapeHandler = mode.defaultEditor.onEscape;
	mode.defaultEditor.onEscape = () => {
		mode.session.abortRetry();
	};
	mode.showStatusIndicator(new RetryStatusIndicator(mode.ui, event.attempt, event.maxAttempts));
	mode.ui.requestRender();
}

export function handleAutoRetryEnd(mode: TermApp, event: AgentEventOf<"auto_retry_end">): void {
	if (mode.retryEscapeHandler) {
		mode.defaultEditor.onEscape = mode.retryEscapeHandler;
		mode.retryEscapeHandler = undefined;
	}
	mode.clearStatusIndicator("retry");
	if (!event.success) {
		mode.showError(`Retry failed: ${event.attempt}`);
	}
	mode.ui.requestRender();
}

export function handleSummarizationRetryScheduled(
	mode: TermApp,
	event: AgentEventOf<"summarization_retry_scheduled">,
): void {
	mode.showError(event.errorMessage);
	mode.showStatusIndicator(new RetryStatusIndicator(mode.ui, event.attempt, event.maxAttempts));
	mode.ui.requestRender();
}

export function handleSummarizationRetryAttemptStart(
	mode: TermApp,
	event: AgentEventOf<"summarization_retry_attempt_start">,
): void {
	mode.clearStatusIndicator("retry");
	if (event.source === "branchSummary") {
		mode.showStatusIndicator(new BranchSummaryStatusIndicator(mode.ui));
	} else {
		mode.showStatusIndicator(new CompactionStatusIndicator(mode.ui, event.reason));
	}
	mode.ui.requestRender();
}

export function handleSummarizationRetryFinished(mode: TermApp): void {
	mode.clearStatusIndicator("retry");
	mode.ui.requestRender();
}

export async function handleEvent(mode: TermApp, event: SessionEvent): Promise<void> {
	if (!mode.isInitialized) {
		await mode.init();
	}

	mode.footer.invalidate();

	switch (event.type) {
		case "agent_start":
			mode.handleAgentStart();
			break;

		case "turn_start":
			mode.handleTurnStart();
			break;

		case "queue_update":
			mode.handleQueueUpdate();
			break;

		case "entry_appended":
			mode.handleEntryAppended(event);
			break;

		case "session_info_changed":
			mode.handleSessionInfoChanged();
			break;

		case "thinking_level_changed":
			mode.handleThinkingLevelChanged();
			break;

		case "message_start":
			mode.handleMessageStart(event);
			break;

		case "message_update":
			mode.handleMessageUpdate(event);
			break;

		case "message_end":
			mode.handleMessageEnd(event);
			break;

		case "bash_execution_update":
			break;

		case "hands_started":
			mode.handleHandsStarted(event);
			break;

		case "hands_updated":
			mode.handleHandsUpdated(event);
			break;

		case "hands_finished":
			mode.handleHandsFinished(event);
			break;

		case "tool_execution_start":
			mode.handleToolExecutionStart(event);
			break;

		case "tool_execution_update":
			mode.handleToolExecutionUpdate(event);
			break;

		case "tool_execution_end":
			mode.handleToolExecutionEnd(event);
			break;

		case "agent_end":
			mode.handleAgentEnd(event);
			break;

		case "agent_settled":
			mode.handleAgentSettled();
			break;

		case "compaction_start":
			mode.handleCompactionStart(event);
			break;

		case "compaction_end":
			mode.handleCompactionEnd(event);
			break;

		case "auto_retry_start":
			mode.handleAutoRetryStart(event);
			break;

		case "auto_retry_end":
			mode.handleAutoRetryEnd(event);
			break;

		case "summarization_retry_scheduled":
			mode.handleSummarizationRetryScheduled(event);
			break;

		case "summarization_retry_attempt_start":
			mode.handleSummarizationRetryAttemptStart(event);
			break;

		case "summarization_retry_finished":
			mode.handleSummarizationRetryFinished();
			break;
	}
}
