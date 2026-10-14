import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@huranth/gama-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CacheWarmer,
	type CacheWarmRequest,
	formatCacheWarmingStatus,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
} from "../src/core/cache/warmer.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";

function testModel(id: string, provider: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: `https://${provider}.test/v1`,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

const adaptiveModel: Model<Api> = {
	...testModel("claude-opus-4-6", "anthropic", "anthropic-messages"),
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	promptCache: { short: 300, long: 3600 },
	compat: { forceAdaptiveThinking: true },
};
const budgetModel: Model<Api> = {
	...testModel("claude-sonnet-4-5", "anthropic", "anthropic-messages"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...testModel("gpt-5", "openai", "openai-completions"),
	promptCache: { short: 300, long: 86_400 },
};

const warmUsage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(
	model: Model<Api>,
	stopReason: AssistantMessage["stopReason"] = "length",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: warmUsage,
		stopReason,
		timestamp: 0,
	};
}

function branchWithPrompt(promptTokens: number): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				...response(adaptiveModel),
				usage: {
					...warmUsage,
					output: 10,
					cacheRead: promptTokens,
					totalTokens: promptTokens + 10,
				},
			},
		},
	];
}

function fakeRuntime(
	options: { mode?: CacheWarmingMode; branch?: SessionEntry[]; fail?: boolean } = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const warmed: UsageEntry[] = [];
	const usageManager = SessionManager.inMemory();
	const appendUsage = vi.fn(usageManager.appendUsage.bind(usageManager));
	const state = {
		mode: options.mode ?? "idle",
		branch: options.branch ?? branchWithPrompt(100_000),
	};
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				return {
					result: async () => response(model, options.fail ? "error" : "length"),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => state.branch },
		() => state.mode,
	);
	warmer.onWarmed = (entry) => warmed.push(entry);
	return { warmer, calls, warmed, appendUsage, state };
}

function request(
	model: Model<Api> = adaptiveModel,
	options: ModelsSimpleStreamOptions = {},
): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

afterEach(() => vi.useRealTimers());

describe("cache warming", () => {
	it("derives timing from the published cache window", () => {
		expect([
			getPromptCacheTtlMs(adaptiveModel, undefined),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" }),
			getPromptCacheTtlMs(adaptiveModel, { env: { GAMA_CACHE_RETENTION: "long" } }),
			getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" }),
		]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000]);
		expect([
			getCacheWarmingDelayMs(300_000),
			getCacheWarmingDelayMs(60_000),
			getCacheWarmingDelayMs(10_000),
		]).toEqual([270_000, 50_000, undefined]);
	});

	it("skips requests that cannot be replayed", () => {
		expect(isReplayable(budgetModel, { reasoning: "medium" })).toBe(false);
		expect(isReplayable(budgetModel, undefined)).toBe(true);
		expect(isReplayable(adaptiveModel, { reasoning: "medium" })).toBe(true);
	});

	it("replays a profitable request before the entry expires", async () => {
		vi.useFakeTimers();
		const { warmer, calls, appendUsage, warmed } = fakeRuntime();
		const signal = new AbortController().signal;

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s" }), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(calls[0]).toMatchObject({
			model: adaptiveModel,
			options: { reasoning: "high", sessionId: "s", maxTokens: 1, maxRetries: 0 },
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			warmUsage,
		);
		expect(warmed).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
		warmer.cancel();
	});

	it("stops when the cache would expire before the refresh lands", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(), current);

		vi.setSystemTime(285_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as {
			run: object | undefined;
			refresh: (run: object) => Promise<void>;
		};
		if (!internal.run) throw new Error("expected an active run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({
			state: "inactive",
			reason: "Cache expired",
		});
	});

	it("stops when the prefix moved or warming is off", () => {
		const { warmer } = fakeRuntime({ mode: "off" });
		warmer.start(request(), current);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "Warming off" });

		const active = fakeRuntime().warmer;
		active.start(request(), () => false);
		expect(active.status).toMatchObject({
			state: "inactive",
			reason: "Context changed",
		});
	});

	it("skips warming when the savings do not clear the threshold", async () => {
		vi.useFakeTimers();
		const priced: Model<Api> = {
			...openaiModel,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 2 },
		};
		const { warmer, calls } = fakeRuntime({ branch: branchWithPrompt(1_000) });
		warmer.start(request(priced), current);

		expect(warmer.status).toMatchObject({ state: "scheduled" });
		await vi.advanceTimersByTimeAsync(270_000);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({
			state: "inactive",
			reason: "No savings",
		});
	});

	it("reports a human readable status", () => {
		expect(formatCacheWarmingStatus({ state: "inactive", reason: "agent run settled" })).toBe(
			"agent run settled",
		);
		const status = formatCacheWarmingStatus(
			{
				state: "scheduled",
				nextWarmAt: 60_000,
				decision: {
					phase: "idle",
					warmCost: 0.03,
					missCost: 0.27,
					continuationProbability: 0.15,
					expectedSavings: 0.01,
					economicsAvailable: true,
					action: "warm",
				},
			},
			0,
		);
		expect(status).toBe("Next in 1m0s");
	});
});
