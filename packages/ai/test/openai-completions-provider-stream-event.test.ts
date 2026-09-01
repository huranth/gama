import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeSimple } from "../src/compat.ts";
import type { CacheRetention, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({ chunks: [] as unknown[] }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks) {
								yield chunk;
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers({ "x-request-id": "req-1" }) },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function openRouterModel(
	id = "openrouter/auto",
	provider = "openrouter",
): Model<"openai-completions"> {
	return {
		id,
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider,
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

type CacheControl = { type: "ephemeral"; ttl?: string };
type CacheableContent = string | Array<{ cache_control?: CacheControl }>;
type CachePayload = {
	messages: Array<{ role: string; content: CacheableContent }>;
	tools?: Array<{ cache_control?: CacheControl }>;
	prompt_cache_retention?: string;
	prompt_cache_key?: string;
};

function deepSeekModel(): Model<"openai-completions"> {
	return {
		...openRouterModel("deepseek-v4.1-flash:free", "tokenharbor"),
		provider: "tokenharbor",
		baseUrl: "https://tokenharbor.ai/v1",
	};
}

async function capturePromptCacheKey(
	model: Model<"openai-completions">,
	options: { sessionId?: string; promptCacheKey?: string; cacheRetention?: CacheRetention },
): Promise<CachePayload> {
	let payload: CachePayload | undefined;
	mockState.chunks = [{ choices: [{ delta: {}, finish_reason: "stop" }] }];
	await completeSimple(
		model,
		{ messages: [{ role: "user", content: "cache probe", timestamp: 0 }] },
		{
			apiKey: "test",
			...options,
			onPayload: (params) => {
				payload = params as CachePayload;
			},
		},
	);
	if (!payload) throw new Error("Expected a completion payload");
	return payload;
}

async function captureUsage(rawUsage: Record<string, unknown>): Promise<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}> {
	mockState.chunks = [{ choices: [{ delta: {}, finish_reason: "stop" }], usage: rawUsage }];
	const message = await completeSimple(
		deepSeekModel(),
		{ messages: [{ role: "user", content: "cache usage", timestamp: 0 }] },
		{ apiKey: "test" },
	);
	return message.usage;
}

function cacheProbeModelWithCompat(sendPromptCacheKey: boolean): Model<"openai-completions"> {
	return { ...deepSeekModel(), provider: "custom-tokenharbor", compat: { sendPromptCacheKey } };
}

async function captureCachePayload(
	id: string,
	provider = "openrouter",
	cacheRetention?: CacheRetention,
): Promise<CachePayload> {
	let payload: CachePayload | undefined;
	mockState.chunks = [{ choices: [{ delta: {}, finish_reason: "stop" }] }];
	await completeSimple(
		openRouterModel(id, provider),
		{
			messages: [
				{
					role: "system",
					content: "Stable instructions",
					toolsAdded: [
						{ name: "read", description: "Read files", parameters: Type.Object({}) },
					],
					timestamp: 0,
				},
				{ role: "user", content: "Next request", timestamp: 1 },
			],
		},
		{
			apiKey: "test",
			cacheRetention,
			onPayload: (params) => {
				payload = params as CachePayload;
			},
		},
	);
	if (!payload) throw new Error("Expected a completion payload");
	return payload;
}

describe("openai-completions provider stream events", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("exposes provider chunks including OpenRouter metadata", async () => {
		const firstChunk = {
			id: "chatcmpl-1",
			model: "anthropic/claude-sonnet-4.6",
			choices: [{ index: 0, delta: { content: "hello" } }],
		};
		const finalChunk = {
			id: "chatcmpl-1",
			model: "anthropic/claude-sonnet-4.6",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 2,
				total_tokens: 12,
				cost: 0.0012,
				is_byok: false,
			},
			openrouter_metadata: { strategy: "direct", region: "iad" },
		};
		mockState.chunks = [firstChunk, finalChunk];
		const events: unknown[] = [];
		const message = await completeSimple(
			openRouterModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", onProviderStreamEvent: (data) => void events.push(data) },
		);
		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(events).toEqual([firstChunk, finalChunk]);
	});
});

describe("cache usage normalization across OpenAI-compatible gateways", () => {
	it("prefers DeepSeek documented cache hits over a conflicting nested mirror", async () => {
		await expect(
			captureUsage({
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_cache_hit_tokens: 40,
				prompt_tokens_details: { cached_tokens: 0 },
			}),
		).resolves.toMatchObject({
			input: 60,
			output: 5,
			cacheRead: 40,
			cacheWrite: 0,
			totalTokens: 105,
		});
	});

	it("uses OpenRouter nested cached_tokens when the DeepSeek field is absent", async () => {
		await expect(
			captureUsage({
				prompt_tokens: 100,
				completion_tokens: 5,
				prompt_tokens_details: { cached_tokens: 72, cache_write_tokens: 8 },
			}),
		).resolves.toMatchObject({
			input: 20,
			output: 5,
			cacheRead: 72,
			cacheWrite: 8,
			totalTokens: 105,
		});
	});
});

describe("prompt-cache affinity compatibility", () => {
	it("does not send unsupported cache-routing fields to Token Harbor DeepSeek", async () => {
		const payload = await capturePromptCacheKey(deepSeekModel(), {
			sessionId: "tokenharbor-session",
			promptCacheKey: "tokenharbor-prefix-key",
			cacheRetention: "long",
		});
		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("allows explicit cache-key opt-in on a custom compatible gateway", async () => {
		const payload = await capturePromptCacheKey(cacheProbeModelWithCompat(true), {
			sessionId: "tokenharbor-session",
			promptCacheKey: "configured-cache-key",
		});
		expect(payload.prompt_cache_key).toBe("configured-cache-key");
	});

	it("omits keys when cache retention disables cache use", async () => {
		const payload = await capturePromptCacheKey(cacheProbeModelWithCompat(true), {
			sessionId: "tokenharbor-session",
			promptCacheKey: "configured-cache-key",
			cacheRetention: "none",
		});
		expect(payload.prompt_cache_key).toBeUndefined();
	});
});

describe("OpenRouter explicit prompt caching", () => {
	it.each([
		"deepseek/deepseek-v3.2",
		"qwen/qwen3-max",
		"qwen/qwen-plus",
		"qwen/qwen3.6-plus",
		"qwen/qwen3-coder-plus",
		"qwen/qwen3-coder-flash",
	])("places short-lived cache markers for %s", async (id) => {
		const payload = await captureCachePayload(id, "openrouter", "long");
		const marker = { type: "ephemeral" };
		expect(payload.messages[0].content).toEqual([
			{ type: "text", text: "Stable instructions", cache_control: marker },
		]);
		expect(payload.tools?.[0].cache_control).toEqual(marker);
		expect(payload.messages.at(-1)?.content).toEqual([
			{ type: "text", text: "Next request", cache_control: marker },
		]);
		expect(payload.prompt_cache_retention).toBeUndefined();
	});

	it("recognizes a custom provider using OpenRouter for Anthropic models", async () => {
		const payload = await captureCachePayload("anthropic/claude-sonnet-5", "custom", "long");
		expect(payload.messages[0].content).toEqual([
			{
				type: "text",
				text: "Stable instructions",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		]);
	});

	it("does not mark unsupported snapshots or disabled caching", async () => {
		const snapshot = await captureCachePayload("qwen/qwen3.5-plus-02-15");
		const disabled = await captureCachePayload("qwen/qwen3-max", "openrouter", "none");
		expect(snapshot.messages[0].content).toBe("Stable instructions");
		expect(snapshot.tools?.[0].cache_control).toBeUndefined();
		expect(disabled.messages[0].content).toBe("Stable instructions");
		expect(disabled.tools?.[0].cache_control).toBeUndefined();
	});
});
