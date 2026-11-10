import type { AgentMessage } from "@huranth/gama-agent-core";
import type { AssistantMessage, Message, Usage } from "@huranth/gama-ai/compat";
import { type Component, type MarkdownTheme, Spacer } from "@huranth/gama-tui";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { MarkdownTransformer } from "../core/ext/index.ts";
import { formatNotice } from "../core/notices.ts";
import { parseSkillBlock } from "../core/session/session.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../core/sessions.ts";
import type { TruncationResult } from "../core/tools/truncate.ts";
import { hasTrustRequiringProjectResources } from "../core/trust-manager.ts";
import type { TermApp } from "./app.ts";
import {
	ActivityLineComponent,
	type ActivityRecord,
	ActivityTickerComponent,
	activityKind,
} from "./parts/activity.ts";
import {
	AssistantMessageComponent,
	hasVisibleAssistantContent,
} from "./parts/assistant-message.ts";
import { BashExecutionComponent } from "./parts/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./parts/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./parts/compaction-summary-message.ts";
import { CustomEntryComponent } from "./parts/custom-entry.ts";
import { CustomMessageComponent } from "./parts/custom-message.ts";
import { formatTokens } from "./parts/footer.ts";
import { SkillInvocationMessageComponent } from "./parts/skill-invocation-message.ts";
import { ThemedText } from "./parts/themed-text.ts";
import { UserMessageComponent } from "./parts/user-message.ts";
import { getMarkdownTheme, theme } from "./theme/theme.ts";

export type CompactionCostNotice = {
	type: "compaction_cost";
	kind: "compaction" | "branch_summary";
	usage: Usage;
};

export type RenderSessionItem =
	| AgentMessage
	| Extract<SessionEntry, { type: "custom" }>
	| CompactionCostNotice;

interface Expandable {
	setExpanded(expanded: boolean): void;
}

export function isExpandable(obj: unknown): obj is Expandable {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"setExpanded" in obj &&
		typeof obj.setExpanded === "function"
	);
}

export class ExpandableText extends ThemedText implements Expandable {
	private readonly state: { expanded: boolean };

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		const state = { expanded };
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), paddingX, paddingY);
		this.state = state;
	}

	setExpanded(expanded: boolean): void {
		this.state.expanded = expanded;
		this.invalidate();
	}
}

function isCustomSessionEntry(
	item: RenderSessionItem,
): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	return "type" in item && item.type === "compaction_cost";
}

export function hasAssistantToolCalls(message: AssistantMessage): boolean {
	return message.content.some((c) => c.type === "toolCall");
}

export function getMarkdownThemeWithSettings(mode: TermApp): MarkdownTheme {
	return {
		...getMarkdownTheme(),
		codeBlockIndent: mode.settingsManager.getCodeBlockIndent(),
	};
}

export function getMarkdownTransformers(mode: TermApp): MarkdownTransformer[] {
	return [
		mode.mermaidMarkdownTransformer,
		...mode.session.extensionRunner.getMarkdownTransformers(),
	];
}

export function configurePromptSummary(
	mode: TermApp,
	component: UserMessageComponent,
	text: string,
): void {
	const sessionId = mode.sessionManager.getSessionId();
	if (mode.promptSummarySessionId !== sessionId) {
		mode.promptSummaries.clear();
		mode.promptSummarySessionId = sessionId;
	}
	component.setPromptSummary({
		enabled: mode.settingsManager.getPromptSummaries(),
		initialText: mode.promptSummaries.get(text),
		generate: async (signal) => {
			const summary = await mode.session.summarizePrompt(text, signal);
			if (mode.promptSummaries.size >= 50) {
				const oldest = mode.promptSummaries.keys().next().value;
				if (oldest !== undefined) mode.promptSummaries.delete(oldest);
			}
			mode.promptSummaries.set(text, summary);
			return summary;
		},
		requestRender: () => mode.ui.requestRender(),
	});
}

export function getUserMessageText(message: Message): string {
	if (message.role !== "user") return "";
	const textBlocks =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter((c: { type: string }) => c.type === "text");
	return textBlocks.map((c) => (c as { text: string }).text).join("");
}

export function showStatus(
	mode: TermApp,
	message: string,
	tone: "dim" | "success" | "warning" | "error" = "dim",
): void {
	const children = mode.chatContainer.children;
	const last = children.length > 0 ? children[children.length - 1] : undefined;
	const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

	if (last && secondLast && last === mode.lastStatusText && secondLast === mode.lastStatusSpacer) {
		mode.lastStatusMessage = message;
		mode.lastStatusTone = tone;
		mode.lastStatusText.invalidate();
		mode.ui.requestRender();
		return;
	}

	const spacer = new Spacer(1);
	mode.lastStatusMessage = message;
	mode.lastStatusTone = tone;
	const text = new ThemedText(() => theme.fg(mode.lastStatusTone, mode.lastStatusMessage), 1, 0);
	mode.chatContainer.addChild(spacer);
	mode.chatContainer.addChild(text);
	mode.lastStatusSpacer = spacer;
	mode.lastStatusText = text;
	mode.ui.requestRender();
}

export function showError(mode: TermApp, errorMessage: string): void {
	mode.chatContainer.addChild(new Spacer(1));
	mode.chatContainer.addChild(
		new ThemedText(
			() => theme.fg("error", `Error: ${formatNotice(errorMessage)}`),
			mode.outputPad,
			0,
		),
	);
	mode.ui.requestRender();
}

export function showWarning(mode: TermApp, warningMessage: string): void {
	mode.chatContainer.addChild(new Spacer(1));
	mode.chatContainer.addChild(
		new ThemedText(() => theme.fg("warning", `Warning: ${formatNotice(warningMessage)}`), 1, 0),
	);
	mode.ui.requestRender();
}

export function addCustomEntryToChat(
	mode: TermApp,
	entry: Extract<SessionEntry, { type: "custom" }>,
): void {
	const renderer = mode.session.extensionRunner.getEntryRenderer(entry.customType);
	if (!renderer) {
		return;
	}
	const component = new CustomEntryComponent(entry, renderer);
	component.setExpanded(mode.toolOutputExpanded);
	if (!component.hasContent()) {
		return;
	}

	if (mode.streamingComponent) {
		const streamingIndex = mode.chatContainer.children.indexOf(mode.streamingComponent);
		if (streamingIndex >= 0) {
			mode.chatContainer.children.splice(streamingIndex, 0, component);
			return;
		}
	}

	mode.chatContainer.addChild(component);
}

export function isSilentTool(toolName: string): boolean {
	if (toolName === "fetch") return false;
	const kind = activityKind(toolName);
	return kind === "reading" || kind === "running";
}

export function resetActivity(mode: TermApp): void {
	for (const activity of mode.activityByToolId.values()) {
		activity.line?.dispose();
	}
	mode.currentActivity = undefined;
	mode.activityByToolId.clear();
}

export function trackActivity(
	mode: TermApp,
	toolCallId: string,
	name: string,
	args: unknown,
	timestamp = Date.now(),
): void {
	if (mode.activityByToolId.has(toolCallId)) return;
	mode.ensureCurrentActivity();
	const ticker = mode.currentActivity as ActivityTickerComponent;
	const record: ActivityRecord = { toolCallId, name, args, status: "pending", timestamp };
	ticker.add(record);
	const line = new ActivityLineComponent({
		record,
		cwd: () => mode.sessionManager.getCwd(),
		ui: mode.ui,
	});
	mode.addToolLine(line);
	mode.activityByToolId.set(toolCallId, { record, ticker, line });
}

export function addChatChild(mode: TermApp, component: Component): Spacer | null {
	const children = mode.chatContainer.children;
	let spacer: Spacer | null = null;
	if (children.length > 0 && !(children[children.length - 1] instanceof Spacer)) {
		spacer = new Spacer(1);
		mode.chatContainer.addChild(spacer);
	}
	mode.chatContainer.addChild(component);
	return spacer;
}

export function dropChatChild(mode: TermApp, component: Component, spacer: Spacer | null): void {
	mode.chatContainer.removeChild(component);
	(component as { dispose?: () => void }).dispose?.();
	if (spacer) mode.chatContainer.removeChild(spacer);
}

// Tool row
export function addToolLine(mode: TermApp, line: ActivityLineComponent): void {
	const children = mode.chatContainer.children;
	const last = children[children.length - 1];
	if (
		children.length > 0 &&
		!(last instanceof Spacer) &&
		!(last instanceof ActivityLineComponent)
	) {
		mode.chatContainer.addChild(new Spacer(1));
	}
	mode.chatContainer.addChild(line);
}

export function ensureCurrentActivity(mode: TermApp): void {
	if (mode.currentActivity) return;
	const ticker = new ActivityTickerComponent({
		ui: mode.ui,
		cwd: () => mode.sessionManager.getCwd(),
	});
	mode.currentActivity = ticker;
}

export function settleRunningActivities(mode: TermApp, message: string): void {
	for (const [toolCallId, activity] of mode.activityByToolId) {
		if (activity.record.status !== "running" && activity.record.status !== "pending") {
			continue;
		}
		mode.updateActivity(toolCallId, {
			status: "error",
			result: { content: [{ type: "text", text: message }] },
		});
	}
}

export function settleCurrentActivity(mode: TermApp): void {
	mode.currentActivity = undefined;
}

export function updateActivity(
	mode: TermApp,
	toolCallId: string,
	update: Partial<ActivityRecord>,
): void {
	const activity = mode.activityByToolId.get(toolCallId);
	if (!activity) return;
	Object.assign(activity.record, update);
	activity.ticker.update(activity.record);
	activity.line?.refresh();
}

export function addMessageToChat(
	mode: TermApp,
	message: AgentMessage,
	options?: { populateHistory?: boolean },
): void {
	switch (message.role) {
		case "bashExecution": {
			const component = new BashExecutionComponent(
				message.command,
				mode.ui,
				message.excludeFromContext,
			);
			if (message.output) {
				component.appendOutput(message.output);
			}
			component.setComplete(
				message.exitCode,
				message.cancelled,
				message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
				message.fullOutputPath,
			);
			mode.chatContainer.addChild(component);
			break;
		}
		case "custom": {
			if (message.display) {
				const renderer = mode.session.extensionRunner.getMessageRenderer(message.customType);
				const component = new CustomMessageComponent(
					message,
					renderer,
					mode.getMarkdownThemeWithSettings(),
					mode.outputPad,
				);
				component.setExpanded(mode.toolOutputExpanded);
				mode.chatContainer.addChild(component);
			}
			break;
		}
		case "compactionSummary": {
			mode.chatContainer.addChild(new Spacer(1));
			const component = new CompactionSummaryMessageComponent(
				message,
				mode.getMarkdownThemeWithSettings(),
			);
			component.setExpanded(mode.toolOutputExpanded);
			mode.chatContainer.addChild(component);
			break;
		}
		case "branchSummary": {
			mode.chatContainer.addChild(new Spacer(1));
			const component = new BranchSummaryMessageComponent(
				message,
				mode.getMarkdownThemeWithSettings(),
			);
			component.setExpanded(mode.toolOutputExpanded);
			mode.chatContainer.addChild(component);
			break;
		}
		case "system":
			break;
		case "user": {
			mode.settleCurrentActivity();
			const textContent = mode.getUserMessageText(message);
			if (textContent) {
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					const component = new SkillInvocationMessageComponent(
						skillBlock,
						mode.getMarkdownThemeWithSettings(),
					);
					component.setExpanded(mode.toolOutputExpanded);
					mode.addChatChild(component);
					if (skillBlock.userMessage) {
						const userComponent = new UserMessageComponent(
							skillBlock.userMessage,
							mode.getMarkdownThemeWithSettings(),
							mode.outputPad,
							mode.getMarkdownTransformers(),
						);
						mode.configurePromptSummary(userComponent, skillBlock.userMessage);
						mode.addChatChild(userComponent);
					}
				} else {
					const userComponent = new UserMessageComponent(
						textContent,
						mode.getMarkdownThemeWithSettings(),
						mode.outputPad,
						mode.getMarkdownTransformers(),
					);
					mode.configurePromptSummary(userComponent, textContent);
					mode.addChatChild(userComponent);
				}
				if (options?.populateHistory) {
					mode.editor.addToHistory?.(textContent);
				}
			}
			break;
		}
		case "assistant": {
			if (!hasVisibleAssistantContent(message)) break;
			const assistantComponent = new AssistantMessageComponent(
				message,
				mode.hideThinkingBlock,
				mode.getMarkdownThemeWithSettings(),
				mode.hiddenThinkingLabel,
				mode.outputPad,
				mode.getMarkdownTransformers(),
				() => mode.ui.requestRender(),
				() => mode.toggleThinkingBlockVisibility(),
			);
			mode.addChatChild(assistantComponent);
			break;
		}
		case "toolResult": {
			break;
		}
		default: {
			message satisfies never;
		}
	}
}

export function renderSessionItems(
	mode: TermApp,
	items: readonly RenderSessionItem[],
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	mode.pendingToolCalls.clear();
	const unresolvedToolCalls = new Set<string>();

	if (options.updateFooter) {
		mode.refreshModelIndicators();
	}

	for (const item of items) {
		if (isCustomSessionEntry(item)) {
			mode.addCustomEntryToChat(item);
			continue;
		}
		if (isCompactionCostNotice(item)) {
			mode.addCompactionCostNotice(item);
			continue;
		}

		const message = item;
		if (message.role === "assistant") {
			mode.addMessageToChat(message);
			for (const content of message.content) {
				if (content.type === "toolCall") {
					mode.trackActivity(content.id, content.name, content.arguments, message.timestamp);

					if (message.stopReason === "aborted" || message.stopReason === "error") {
						let errorMessage: string;
						if (message.stopReason === "aborted") {
							const retryAttempt = mode.session.retryAttempt;
							errorMessage = retryAttempt > 0 ? `Aborted: ${retryAttempt}` : "Aborted";
						} else {
							errorMessage = message.errorMessage || "Error";
						}
						mode.updateActivity(content.id, {
							status: "error",
							result: { content: [{ type: "text", text: errorMessage }] },
						});
					} else {
						unresolvedToolCalls.add(content.id);
					}
				}
			}
		} else if (message.role === "toolResult") {
			if (unresolvedToolCalls.delete(message.toolCallId)) {
				mode.updateActivity(message.toolCallId, {
					status: message.isError ? "error" : "success",
					result: { content: message.content, details: message.details },
				});
			}
		} else {
			mode.addMessageToChat(message, options);
		}
	}

	for (const toolCallId of unresolvedToolCalls) {
		if (mode.session.isStreaming !== false) {
			mode.pendingToolCalls.add(toolCallId);
		} else {
			mode.updateActivity(toolCallId, {
				status: "error",
				result: {
					content: [
						{
							type: "text",
							text: "Tool call ended",
						},
					],
				},
			});
		}
	}
	if (mode.session.isStreaming === false) mode.settleCurrentActivity();
	mode.ui.requestRender();
}

export function renderSessionEntries(
	mode: TermApp,
	entries: SessionEntry[],
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	const items = entries.flatMap((entry): RenderSessionItem[] => {
		if (entry.type === "custom") {
			return [entry];
		}
		const messages = sessionEntryToContextMessages(entry);
		if (
			(entry.type === "compaction" || entry.type === "branch_summary") &&
			entry.usage &&
			messages.length > 0
		) {
			return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
		}
		return messages;
	});
	mode.renderSessionItems(items, options);
}

export function addCompactionCostNotice(mode: TermApp, notice: CompactionCostNotice): void {
	const { usage } = notice;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
	const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
	mode.chatContainer.addChild(new Spacer(1));
	mode.chatContainer.addChild(
		new ThemedText(
			() => theme.fg("muted", `${label}: ${formatTokens(tokens)} tokens${cost}`),
			1,
			0,
		),
	);
}

export function countDroppedThinkingBlocks(message: AssistantMessage): number {
	let count = 0;
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "anthropic_input_transformations") continue;
		const transformations = diagnostic.details?.transformations;
		if (!Array.isArray(transformations)) continue;
		count += transformations.filter(
			(transformation) =>
				typeof transformation === "object" &&
				transformation !== null &&
				(transformation as Record<string, unknown>).type === "thinking_dropped",
		).length;
	}
	return count;
}

export function maybeShowThinkingDropNotice(mode: TermApp, message: AssistantMessage): void {
	const droppedCount = countDroppedThinkingBlocks(message);
	if (droppedCount === 0) return;

	let previousDroppedCount = 0;
	const branch = mode.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			previousDroppedCount = countDroppedThinkingBlocks(entry.message);
			break;
		}
	}
	if (droppedCount <= previousDroppedCount) return;

	const noun = droppedCount === 1 ? "thinking block" : "thinking blocks";
	mode.chatContainer.addChild(new Spacer(1));
	mode.chatContainer.addChild(
		new ThemedText(() => theme.fg("warning", `Dropped: ${droppedCount} ${noun}`), 1, 0),
	);
}

export function renderInitialMessages(mode: TermApp): void {
	const entries = mode.sessionManager.buildContextEntries();
	mode.renderSessionEntries(entries, {
		updateFooter: true,
		populateHistory: true,
	});
	mode.renderProjectTrustWarningIfNeeded();

	const allEntries = mode.sessionManager.getEntries();
	const compactionCount = allEntries.filter((entry) => entry.type === "compaction").length;
	if (compactionCount > 0) {
		const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
		mode.showStatus(`Session compacted ${times}`);
	}
}

export function renderProjectTrustWarningIfNeeded(mode: TermApp): void {
	if (
		mode.settingsManager.isProjectTrusted() ||
		!hasTrustRequiringProjectResources(mode.sessionManager.getCwd())
	) {
		return;
	}

	if (mode.chatContainer.children.length > 0) {
		mode.chatContainer.addChild(new Spacer(1));
	}
	mode.chatContainer.addChild(
		new ThemedText(
			() => {
				const note = [
					"This project is not trusted. ",
					`Project ${CONFIG_DIR_NAME} resources and packages are ignored. `,
					"Restart gama with --approve to trust this project for one run",
				].join("");
				return theme.fg("warning", note);
			},
			1,
			0,
		),
	);
}
