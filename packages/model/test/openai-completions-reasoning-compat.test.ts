import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { stream as streamOpenAICompletions } from "../src/wire/openai-completions.ts";

const mockState = vi.hoisted(() => ({
	payloads: [] as Array<Record<string, unknown>>,
	errors: [] as Error[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (payload: unknown) => {
					mockState.payloads.push(payload as Record<string, unknown>);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						const error = mockState.errors.shift();
						if (error) throw error;
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function model(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "gateway",
		baseUrl: "https://gateway.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function assistantWithReasoning(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal plan", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "previous answer" },
		],
		api: "openai-completions",
		provider: "gateway",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

const context = normalizeContext({
	messages: [
		{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 },
		assistantWithReasoning(),
		{ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 },
	],
	tools: [],
});

function assistantPayload(payload: Record<string, unknown> | undefined) {
	const messages = payload?.messages as Array<Record<string, unknown>> | undefined;
	return messages?.find((message) => message.role === "assistant");
}

async function consume() {
	return await streamOpenAICompletions(model(), context, { apiKey: "test" }).result();
}

describe("openai-completions reasoning compatibility", () => {
	beforeEach(() => {
		mockState.payloads = [];
		mockState.errors = [];
	});

	it("retries once without reasoning fields when the provider rejects them", async () => {
		const body = JSON.stringify({
			type: "invalid_request_error",
			code: "COMPATIBILITY_ERROR",
			message: "unsupported:reasoning_content",
		});
		mockState.errors = [
			Object.assign(new Error(`400: ${body}`), {
				status: 400,
				body,
				headers: new Headers(),
			}),
		];

		const result = await consume();

		expect(result.stopReason).toBe("stop");
		expect(mockState.payloads).toHaveLength(2);

		const first = assistantPayload(mockState.payloads[0]);
		expect(first?.reasoning_content).toBe("internal plan");

		const retried = assistantPayload(mockState.payloads[1]);
		expect(retried?.reasoning).toBeUndefined();
		expect(retried?.reasoning_content).toBeUndefined();
		expect(retried?.reasoning_text).toBeUndefined();
		expect(retried?.reasoning_details).toBeUndefined();
	});

	it("does not retry unrelated bad requests", async () => {
		const body = JSON.stringify({
			type: "invalid_request_error",
			message: "unsupported parameter: temperature",
		});
		mockState.errors = [
			Object.assign(new Error(`400: ${body}`), {
				status: 400,
				body,
				headers: new Headers(),
			}),
		];

		const result = await consume();

		expect(result.stopReason).toBe("error");
		expect(mockState.payloads).toHaveLength(1);
	});
});
