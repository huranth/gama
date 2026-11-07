import * as fs from "node:fs";
import type { ThinkingLevel } from "@huranth/gama-agent-core";
import { Spacer } from "@huranth/gama-tui";
import { parseThinkingLevel } from "../start/args.ts";
import { cacheRows, formatCacheWarmingStatus } from "../core/cache/index.ts";
import { reasoningLevelName } from "../core/defaults.ts";
import type { TermApp } from "./app.ts";
import { AssistantMessageComponent } from "./parts/assistant-message.ts";
import { formatTokens } from "./parts/footer.ts";
import { ThemedText } from "./parts/themed-text.ts";
import { ThinkingSelectorComponent } from "./parts/thinking-selector.ts";
import { theme } from "./theme/theme.ts";
import { isExpandable } from "./chat.ts";

export type DeliveryMode = "steer" | "followUp";

export function parseDeliveryPrefix(text: string): {
	text: string;
	delivery?: DeliveryMode;
	setDefault?: DeliveryMode;
} {
	const command = /^\/([sq])\s*$/i.exec(text);
	if (command) {
		return {
			text: "",
			setDefault: command[1].toLowerCase() === "q" ? "followUp" : "steer",
		};
	}

	const match = /^\/([sq])\s+([\s\S]*)$/i.exec(text);
	if (!match) return { text };

	const body = match[2].trim();
	if (!body) return { text: "" };

	return {
		text: body,
		delivery: match[1].toLowerCase() === "q" ? "followUp" : "steer",
	};
}

const KIB_SIZE = 1024;

const MIB_SIZE = KIB_SIZE * 1024;

const SIZE_DECIMALS = 1;

function formatBytes(bytes: number): string {
	if (bytes < KIB_SIZE) return `${bytes} B`;
	if (bytes < MIB_SIZE) return `${(bytes / KIB_SIZE).toFixed(SIZE_DECIMALS)} KB`;
	return `${(bytes / MIB_SIZE).toFixed(SIZE_DECIMALS)} MB`;
}

export function handleReasonCommand(mode: TermApp, argument: string | undefined): void {
	const levels = mode.session.getAvailableThinkingLevels();
	if (argument !== undefined) {
		const tier = parseThinkingLevel(argument);
		if (tier === undefined) {
			mode.showWarning(`Unknown reasoning level: ${argument}`);
			return;
		}
		mode.applyReasoningLevel(tier);
		return;
	}
	const current = mode.session.thinkingLevel ?? "off";
	mode.showSelector((done) => {
		const selector = new ThinkingSelectorComponent(
			current,
			levels,
			(level) => {
				done();
				mode.applyReasoningLevel(level);
			},
			() => {
				done();
				mode.ui.requestRender();
			},
			(level) => {
				done();
				mode.applyReasoningLevel(level);
			},
			mode.settingsManager.getDefaultThinkingLevel(),
		);
		return { component: selector, focus: selector };
	});
}

export function applyReasoningLevel(mode: TermApp, level: ThinkingLevel): void {
	mode.session.setThinkingLevel(level, { persist: true });
	mode.refreshModelIndicators();
	mode.showStatus(`Reasoning level: ${reasoningLevelName(level)}`);
}

export function cycleThinkingLevel(mode: TermApp): void {
	const newLevel = mode.session.cycleThinkingLevel({ persist: true });
	if (newLevel === undefined) {
		mode.showStatus("Thinking unsupported");
	} else {
		mode.refreshModelIndicators();
		mode.showStatus(`Reasoning level: ${reasoningLevelName(newLevel)}`);
	}
}

export async function cycleModel(
	mode: TermApp,
	direction: "forward" | "backward",
): Promise<void> {
	try {
		// Save default
		const result = await mode.session.cycleModel(direction, { persist: true });
		if (result === undefined) {
			const msg =
				mode.session.scopedModels.length > 0
					? "Single model"
					: "Single model";
			mode.showStatus(msg);
		} else {
			mode.refreshModelIndicators();
			const thinkingStr =
				result.model.reasoning && result.thinkingLevel !== "off"
					? ` (reasoning: ${reasoningLevelName(result.thinkingLevel)})`
					: "";
			const modelLabel = result.model.name || result.model.id;
			mode.showStatus(`Model: ${modelLabel}${thinkingStr}`);
			void mode.maybeWarnAboutAnthropicSubscriptionAuth(result.model);
		}
	} catch (error) {
		mode.showError(error instanceof Error ? error.message : String(error));
	}
}

export function toggleToolOutputExpansion(mode: TermApp): void {
	mode.setToolsExpanded(!mode.toolOutputExpanded);
}

export function setToolsExpanded(mode: TermApp, expanded: boolean): void {
	if (expanded === mode.toolOutputExpanded) return;

	mode.toolOutputExpanded = expanded;
	const activeHeader = mode.customHeader ?? mode.builtInHeader;
	if (isExpandable(activeHeader)) {
		activeHeader.setExpanded(expanded);
	}
	for (const container of [mode.loadedResourcesContainer, mode.chatContainer]) {
		for (const child of container.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
	}
	mode.handViewComponent?.setToolOutputExpanded(expanded);
	mode.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
}

export function updateThinkingBlockVisibility(mode: TermApp): void {
	for (const child of mode.chatContainer.children) {
		if (child instanceof AssistantMessageComponent) {
			child.setHideThinkingBlock(mode.hideThinkingBlock);
		}
	}
	mode.handViewComponent?.setHideThinkingBlock(mode.hideThinkingBlock);
	mode.ui.requestRender();
}

export function toggleThinkingBlockVisibility(mode: TermApp): void {
	mode.hideThinkingBlock = !mode.hideThinkingBlock;
	mode.settingsManager.setHideThinkingBlock(mode.hideThinkingBlock);
	mode.updateThinkingBlockVisibility();
}

export async function handleFollowUp(mode: TermApp): Promise<void> {
	const text = (mode.editor.getExpandedText?.() ?? mode.editor.getText()).trim();
	if (!text) return;

	if (await mode.routeBuiltinInput(text)) return;

	if (mode.session.isCompacting) {
		if (mode.isExtensionCommand(text)) {
			mode.editor.addToHistory?.(text);
			mode.editor.setText("");
			try {
				await mode.session.prompt(text);
			} catch (error) {
				mode.reportPromptFailure(text, error);
			}
		} else {
			mode.queueCompactionMessage(text, "followUp");
		}
		return;
	}

	if (mode.session.isStreaming) {
		mode.editor.addToHistory?.(text);
		mode.editor.setText("");
		try {
			await mode.session.prompt(text, { streamingBehavior: "followUp" });
		} catch (error) {
			mode.reportPromptFailure(text, error);
			return;
		}
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
	} else if (mode.editor.onSubmit) {
		mode.editor.setText("");
		mode.editor.onSubmit(text);
	}
}

export function handleDequeue(mode: TermApp): void {
	const restored = mode.restoreQueuedMessagesToEditor();
	if (restored === 0) {
		mode.showStatus("No queued messages");
	} else {
		mode.showStatus(`Restored ${restored}`);
	}
}

export function showContextPanel(
	mode: TermApp,
	rows: ReadonlyArray<[string, string]>,
): void {
	mode.chatContainer.addChild(new Spacer(1));
	for (const [label, value] of rows) {
		mode.chatContainer.addChild(
			new ThemedText(
				() => ` ${theme.fg("dim", `${label} `)}${theme.fg("text", value)}`,
				1,
				0,
			),
		);
	}
	mode.ui.requestRender();
}

export function showCachePanel(mode: TermApp): void {
	const snapshot = mode.session.cacheSnapshot();
	const rows = cacheRows(snapshot);
	const warming = mode.session.cacheWarmingStatus;
	if (warming) rows.push(["warming", formatCacheWarmingStatus(warming)]);
	mode.showContextPanel(rows);
}

export function showStatsPanel(mode: TermApp): void {
	const stats = mode.session.getSessionStats();
	const usage = stats.contextUsage;
	const context =
		usage?.tokens != null
			? `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}`
			: usage
				? `${formatTokens(usage.contextWindow)} window`
				: "unknown";

	let fileSize = 0;
	if (stats.sessionFile) {
		try {
			fileSize = fs.statSync(stats.sessionFile).size;
		} catch {}
	}
	const session = [
		fileSize > 0 ? formatBytes(fileSize) : "",
		`${stats.totalMessages} msgs`,
		`${stats.toolCalls} tools`,
	]
		.filter(Boolean)
		.join(", ");
	const tokens = `in ${formatTokens(stats.tokens.input)}, out ${formatTokens(stats.tokens.output)}`;

	mode.showContextPanel([
		["context", context],
		["session", session],
		["tokens", tokens],
	]);
}

export function parseContextWindowInput(raw: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw.trim());
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const unit = match[2]?.toLowerCase();
	const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
	return Math.round(value * multiplier);
}
