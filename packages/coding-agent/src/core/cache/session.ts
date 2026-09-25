import { type Api, type CacheRetention, type Model, requiresExplicitCache } from "@huranth/gama-ai";
import type { AssistantMessage } from "@huranth/gama-ai/compat";
import type { SessionEntry } from "../session-manager.ts";
import {
	billedCost,
	type CacheRates,
	type CacheTotals,
	type CacheTurn,
	cacheTotals,
	hitRate,
	projectCost,
	promptTokens,
} from "./rate.ts";

export type CacheColdReason =
	| "first-request"
	| "model-switched"
	| "compacted"
	| "cache-expired"
	| "prompt-changed"
	| "new-tokens";

export interface CacheSnapshot {
	rates: number[];
	latest: number;
	latestReason?: CacheColdReason;
	totals: CacheTotals;
	warmTurns: number;
	coldTurns: number;
	warmRatio: number;
	unreported: number;
	lookbackPositions: number | undefined;
	warmSpent: number;
	warmRequests: number;
	windowMs: number | undefined;
	leftMs: number;
	nextWarm: number | undefined;
	nextCold: number | undefined;
	model: string | undefined;
}

export interface CacheBuildInput {
	entries: readonly SessionEntry[];
	resolveModel: (provider: string, modelId: string) => Model<Api> | undefined;
	retention?: CacheRetention;
	assumedWindowMs?: number;
	now?: number;
}

export interface CacheWindowOptions {
	retention?: CacheRetention;
	entries?: readonly SessionEntry[];
	assumedMs?: number;
}

function isAssistant(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> & {
	message: AssistantMessage;
} {
	return entry.type === "message" && entry.message.role === "assistant";
}

function messageKey(message: AssistantMessage): string {
	return `${message.provider}/${message.responseModel ?? message.model}`;
}

// Reported.
function hasReportedUsage(message: AssistantMessage): boolean {
	return promptTokens(message.usage) > 0 || message.usage.output > 0;
}

function hasCompaction(entries: readonly SessionEntry[]): boolean {
	return entries.some((entry) => entry.type === "compaction" || entry.type === "branch_summary");
}

function hasSystemMessage(entries: readonly SessionEntry[]): boolean {
	return entries.some((entry) => entry.type === "message" && entry.message.role === "system");
}

export function cacheRatesOf(model: Model<Api> | undefined): CacheRates | undefined {
	if (!model) return undefined;
	const { input, cacheRead, cacheWrite, tiers } = model.cost;
	if (!(input > 0)) return undefined;
	return { input, cacheRead, cacheWrite, ...(tiers ? { tiers } : {}) };
}

function warmUsage(
	entries: readonly SessionEntry[],
	resolveModel: (provider: string, modelId: string) => Model<Api> | undefined,
): { warmSpent: number; warmRequests: number } {
	let warmSpent = 0;
	let warmRequests = 0;
	for (const entry of entries) {
		if (entry.type !== "usage" || entry.kind !== "cache_warm") continue;
		const rates = cacheRatesOf(resolveModel(entry.provider, entry.model));
		warmRequests += 1;
		warmSpent += billedCost(entry.usage, rates);
	}
	return { warmSpent, warmRequests };
}

function forecastCosts(
	last: AssistantMessage | undefined,
	rates: CacheRates | undefined,
	prompts: number[],
	model: Model<Api> | undefined,
): { nextWarm: number | undefined; nextCold: number | undefined } {
	if (!last || !rates) return { nextWarm: undefined, nextCold: undefined };
	const prompt = promptTokens(last.usage);
	const previous = prompts[prompts.length - 2] ?? prompt;
	const added = Math.max(0, prompt - previous);
	const base = {
		rates,
		prompt,
		output: last.usage.output,
		outputRate: model?.cost.output ?? 0,
		added,
	};
	return {
		nextWarm: projectCost({ ...base, warm: true }),
		nextCold: projectCost({ ...base, warm: false }),
	};
}

export function cacheWindowOf(
	model: Model<Api> | undefined,
	retention: CacheRetention = "short",
): number | undefined {
	if (retention === "none") return undefined;
	const short = model?.promptCache?.short;
	const seconds = model?.promptCache?.[retention] ?? (retention === "long" ? short : undefined);
	if (!seconds || seconds <= 0) return undefined;
	return seconds * 1000;
}

function lookbackPositionsOf(
	assistant: Array<{ message: AssistantMessage; index: number }>,
	last: AssistantMessage,
): number | undefined {
	const lastIndex = assistant.length - 1;
	for (let index = lastIndex - 1; index >= 0; index--) {
		const message = assistant[index]!.message;
		if (messageKey(message) !== messageKey(last)) return undefined;
		if (message.usage.cacheWrite > 0) return lastIndex - index;
	}
	return undefined;
}

export function buildCacheSnapshot(input: CacheBuildInput): CacheSnapshot {
	const { turns, prompts, assistant, last, latest, unreported } = collectTurns(
		input.entries,
		input.resolveModel,
	);
	const current = latest ?? last;
	const model = current
		? input.resolveModel(current.provider, current.responseModel ?? current.model)
		: undefined;

	// Rates
	const rates = turns.map((turn) => hitRate(turn.usage));
	const windowMs = resolveCacheWindowMs(model, {
		retention: input.retention,
		entries: input.entries,
		assumedMs: input.assumedWindowMs,
	});

	const now = input.now ?? Date.now();
	const leftMs = windowMs && current ? Math.max(0, current.timestamp + windowMs - now) : 0;

	// Warm.
	const { warmSpent, warmRequests } = warmUsage(input.entries, input.resolveModel);
	const { nextWarm, nextCold } = forecastCosts(last, cacheRatesOf(model), prompts, model);
	const warmTurns = turns.filter((turn) => turn.usage.cacheRead > 0);
	const warmPrompt = warmTurns.reduce((sum, turn) => sum + promptTokens(turn.usage), 0);
	const warmRead = warmTurns.reduce((sum, turn) => sum + turn.usage.cacheRead, 0);

	const lookbackPositions =
		last &&
		requiresExplicitCache({
			id: last.responseModel ?? last.model,
			provider: last.provider,
		})
			? lookbackPositionsOf(assistant, last)
			: undefined;

	return {
		rates,
		latest: rates.at(-1) ?? 0,
		latestReason: coldReason(input.entries, assistant, windowMs),
		totals: cacheTotals(turns),
		warmTurns: warmTurns.length,
		coldTurns: turns.length - warmTurns.length,
		warmRatio: warmPrompt === 0 ? 0 : warmRead / warmPrompt,
		unreported: unreported,
		lookbackPositions,
		windowMs,
		leftMs,
		warmSpent,
		warmRequests,
		nextWarm,
		nextCold,
		model: model ? `${model.provider}/${model.id}` : undefined,
	};
}

// Lookback.
export function resolveCacheWindowMs(
	model: Model<Api> | undefined,
	options: CacheWindowOptions = {},
): number | undefined {
	if (options.retention === "none") return undefined;
	const declared = cacheWindowOf(model, options.retention);
	if (declared !== undefined) return declared;
	const observed = observedCacheWindowMs(options.entries ?? [], model);
	if (observed === undefined) return undefined;
	if (options.assumedMs === undefined) return observed;
	return Math.max(observed, options.assumedMs);
}

function collectTurns(
	entries: readonly SessionEntry[],
	resolveModel: (provider: string, modelId: string) => Model<Api> | undefined,
): {
	turns: CacheTurn[];
	prompts: number[];
	assistant: Array<{ message: AssistantMessage; index: number }>;
	last: AssistantMessage | undefined;
	latest: AssistantMessage | undefined;
	unreported: number;
} {
	const turns: CacheTurn[] = [];
	const prompts: number[] = [];
	const assistant: Array<{ message: AssistantMessage; index: number }> = [];
	let last: AssistantMessage | undefined;
	let latest: AssistantMessage | undefined;
	let unreported = 0;

	for (const [index, entry] of entries.entries()) {
		if (!isAssistant(entry)) continue;
		const message = entry.message;
		const model = resolveModel(message.provider, message.responseModel ?? message.model);
		latest = message;
		if (!hasReportedUsage(message)) {
			// Replay.
			if (message.stopReason !== "error" && message.stopReason !== "aborted") unreported += 1;
			continue;
		}
		turns.push({ usage: message.usage, rates: cacheRatesOf(model) });
		prompts.push(promptTokens(message.usage));
		assistant.push({ message, index });
		last = message;
	}

	return { turns, prompts, assistant, last, latest, unreported };
}

export function observedCacheWindowMs(
	entries: readonly SessionEntry[],
	model?: Pick<Model<Api>, "provider" | "id">,
): number | undefined {
	let previous: number | undefined;
	let longest: number | undefined;

	for (const entry of entries) {
		if (!isAssistant(entry) || !hasReportedUsage(entry.message)) continue;
		const message = entry.message;
		const sameModel =
			!model ||
			(message.provider === model.provider &&
				(message.responseModel ?? message.model) === model.id);
		if (!sameModel) continue;
		const gap = previous === undefined ? 0 : message.timestamp - previous;
		if (gap > 0 && message.usage.cacheRead > 0) {
			longest = Math.max(longest ?? 0, gap);
		}
		previous = message.timestamp;
	}

	return longest;
}

// Declared.
function coldReason(
	entries: readonly SessionEntry[],
	assistant: Array<{ message: AssistantMessage; index: number }>,
	windowMs: number | undefined,
): CacheColdReason | undefined {
	const current = assistant.at(-1);
	const previous = assistant.at(-2);
	if (!current || !previous) return "first-request";

	const between = entries.slice(previous.index + 1, current.index);
	if (messageKey(current.message) !== messageKey(previous.message)) return "model-switched";
	if (hasCompaction(between)) return "compacted";

	// Prefix.
	const currentPrefix = current.message.promptPrefixHash;
	const previousFull = previous.message.promptHash;
	if (
		currentPrefix !== undefined &&
		previousFull !== undefined &&
		currentPrefix !== previousFull
	) {
		return "prompt-changed";
	}

	const gap = current.message.timestamp - previous.message.timestamp;
	if (windowMs !== undefined && gap > windowMs) return "cache-expired";
	if (hasSystemMessage(between)) return "prompt-changed";
	if (hitRate(current.message.usage) < 1) return "new-tokens";

	return undefined;
}
