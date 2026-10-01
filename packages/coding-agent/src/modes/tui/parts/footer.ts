import type { Usage } from "@huranth/gama-ai/compat";
import { type Component, truncateToWidth, visibleWidth } from "@huranth/gama-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { CacheSnapshot } from "../../../core/cache/index.ts";
import { formatMoney, formatPercent, hitTone } from "../../../core/cache/view.ts";
import { reasoningLevelName } from "../../../core/defaults.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/ext/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import {
	addUsageToTotals,
	createUsageTotals,
	type UsageTotals,
} from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

const CTX_WARN = 70;
const CTX_ERROR = 90;
const MIN_PADDING = 2;
const CHIP_BG = "userMessageBg";

interface StreamingUsage {
	usage?: Usage;
	estimatedOutputTokens: number;
	baseEntryCount: number;
	seed: Usage;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	streaming?: StreamingUsage;
	usageTotals: UsageTotals;
	cache: CacheSnapshot;
	contextUsage?: ContextUsage;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const index = normalized.lastIndexOf("/");
	if (index === -1) return normalized || cwd;
	return normalized.slice(index + 1) || normalized;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function blendUsage(streaming: StreamingUsage): Usage {
	const real = streaming.usage;
	const seed = streaming.seed;
	const estimated = streaming.estimatedOutputTokens;

	return {
		input: real?.input ?? seed.input,
		output: real?.output ?? (estimated > 0 ? estimated : seed.output),
		cacheRead: real?.cacheRead ?? seed.cacheRead,
		cacheWrite: real?.cacheWrite ?? seed.cacheWrite,
		totalTokens: real?.totalTokens ?? seed.totalTokens,
		cost: real && real.cost.total > 0 ? real.cost : seed.cost,
	};
}

export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;
	private streaming?: StreamingUsage;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setStreamingUsage(usage?: Usage, estimatedOutputTokens = 0): void {
		if (!this.streaming) {
			this.streaming = {
				usage,
				estimatedOutputTokens,
				baseEntryCount: this.session.sessionManager.getEntryCount(),
				seed: this.getLastRequestUsage(),
			};
			return;
		}

		this.streaming = { ...this.streaming, usage, estimatedOutputTokens };
	}

	clearStreamingUsage(): void {
		this.streaming = undefined;
	}

	invalidate(): void {}

	dispose(): void {}

	private getLastRequestUsage(): Usage {
		const entries = this.session.sessionManager.getEntries();

		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];

			if (entry.type === "message" && entry.message.role === "assistant") {
				return entry.message.usage;
			}
			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.usage
			) {
				return entry.message.usage;
			}
			if (entry.type === "usage") return entry.usage;
		}

		return zeroUsage();
	}

	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const streaming =
			this.streaming && this.streaming.baseEntryCount < entryCount ? undefined : this.streaming;
		const cached = this.sessionStats;

		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel &&
			cached.streaming === streaming
		) {
			return cached;
		}

		const usageTotals = createUsageTotals();

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.usage
			) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if (
				(entry.type === "branch_summary" || entry.type === "compaction") &&
				entry.usage
			) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		if (streaming) addUsageToTotals(usageTotals, blendUsage(streaming));

		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			streaming,
			usageTotals,
			cache: this.session.cacheSnapshot(),
			contextUsage: this.session.getContextUsage(),
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const { usageTotals, cache, contextUsage } = this.getSessionStats();
		const dim = (text: string) => theme.fg("dim", text);

		const hitValue =
			cache.rates.length === 0
				? dim("n/a")
				: theme.fg(hitTone(cache.latest), formatPercent(cache.latest));
		const costSegment = theme.fg("muted", formatMoney(usageTotals.cost));

		// Context chip.
		const percent = contextUsage?.percent;
		const hot = percent !== null && percent !== undefined && percent > CTX_WARN;
		const auto = this.autoCompactEnabled ? " auto" : "";
		const contextChip = hot
			? theme.fg(percent > CTX_ERROR ? "error" : "warning", `ctx ${percent.toFixed(0)}%${auto}`)
			: undefined;
		const experimental = areExperimentalFeaturesEnabled() ? theme.fg("warning", "xp") : undefined;
		const rightSide = this.modelLabel();

		const buildLeft = (options: { cost: boolean }) => {
			const stats = options.cost ? `${hitValue}  ${costSegment}` : hitValue;
			let left = `${dim("cache")} ${this.chip(stats)}`;
			if (contextChip) left += `  ${contextChip}`;
			if (experimental) left += `  ${experimental}`;
			return left;
		};
		const fits = (left: string) =>
			visibleWidth(left) + MIN_PADDING + visibleWidth(rightSide) <= width;

		let statsLeft = buildLeft({ cost: true });
		if (!fits(statsLeft)) statsLeft = buildLeft({ cost: false });

		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, dim("..."));
			statsLeftWidth = visibleWidth(statsLeft);
		}

		const availableForRight = width - statsLeftWidth - MIN_PADDING;
		let statsLine = statsLeft;

		if (availableForRight > 0) {
			const visibleRight = truncateToWidth(rightSide, availableForRight, "");
			const padding = " ".repeat(
				Math.max(0, width - statsLeftWidth - visibleWidth(visibleRight)),
			);
			statsLine = statsLeft + padding + theme.fg("muted", visibleRight);
		}

		const lines = [statsLine];
		const extensionStatuses = this.footerData.getExtensionStatuses();

		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}

	private chip(content: string): string {
		const bgAnsi = theme.getBgAnsi(CHIP_BG);
		return theme.bg(CHIP_BG, ` ${content.replace(/\x1b\[0m/g, `\x1b[0m${bgAnsi}`)} `);
	}

	private modelLabel(): string {
		const state = this.session.state;
		const modelName = state.model?.id || "no-model";
		// Keep level.
		const thinkingLevel = state.thinkingLevel || "off";
		let label = `${modelName} ${this.chip(reasoningLevelName(thinkingLevel))}`;

		const routed = this.session.routedModel;
		if (routed) {
			const level = routed.thinkingLevel
				? ` ${this.chip(reasoningLevelName(routed.thinkingLevel))}`
				: "";
			label += ` on ${routed.model.id}${level}`;
		}

		return label;
	}
}
