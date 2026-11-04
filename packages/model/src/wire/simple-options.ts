import type {
	Api,
	CacheRetention,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	TranscriptContext,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

const CONTEXT_SAFETY_TOKENS = 4096;

const MIN_MAX_TOKENS = 1;

export const MIN_ANSWER_TOKENS = 1024;

export function resolveCacheRetention(
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}

	if (getProviderEnvValue("GAMA_CACHE_RETENTION", env) === "long") {
		return "long";
	}

	return "short";
}

export function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) {
		return false;
	}

	const expected = name.toLowerCase();

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== expected || value === null) continue;

		if (value.trim().length > 0) return true;
	}

	return false;
}

export function getClientApiKey(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): string {
	if (apiKey) {
		return apiKey;
	}

	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) {
		return "unused";
	}

	throw new Error(`No API key: ${provider}`);
}

export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

export function clampReasoning(
	effort: ThinkingLevel | undefined,
): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	if (effort === "xhigh" || effort === "max") {
		return "high";
	}

	return effort;
}

export function thinkingBudgetForLevel(
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	const merged = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	const budgets = merged as Record<ThinkingLevel, number>;
	const level = clampReasoning(reasoningLevel) ?? "high";

	return budgets[level];
}

export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	const answerRoom = ceiling - MIN_ANSWER_TOKENS;
	return Math.min(thinkingBudget, Math.max(0, answerRoom));
}

export function adjustMaxTokensForThinking(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);

	if (baseMaxTokens === undefined) {
		return { maxTokens: modelMaxTokens, thinkingBudget };
	}

	const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	const needsRoom = maxTokens <= thinkingBudget;
	if (needsRoom) thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);

	return { maxTokens, thinkingBudget };
}

export function clampMaxTokensToContext(
	model: Model<Api>,
	context: TranscriptContext,
	maxTokens: number,
): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);

	const used = estimateContextTokens(context).tokens;
	const available = model.contextWindow - used - CONTEXT_SAFETY_TOKENS;

	const room = Math.max(MIN_MAX_TOKENS, available);

	return Math.min(maxTokens, room);
}

export function buildBaseOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const requested = options?.maxTokens ?? model.maxTokens;
	const maxTokens = clampMaxTokensToContext(model, context, requested);

	return {
		temperature: options?.temperature,
		samplingParams: options?.samplingParams,
		maxTokens,
		signal: options?.signal,
		telemetryContext: options?.telemetryContext,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}
