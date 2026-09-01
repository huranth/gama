import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Message, Model, Tool, Usage } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	params: undefined as any,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.params = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-1",
								model: "routed",
								choices: [{ index: 0, delta: { content: "hi" } }],
							};
							yield {
								id: "chatcmpl-1",
								model: "routed",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 10, completion_tokens: 2 },
							};
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
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function gatewayModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "tokenharbor",
		baseUrl: "https://tokenharbor.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

const context = {
	systemPrompt: "you are a test",
	messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
};
const tool: Tool = {
	name: "bash",
	description: "run a command",
	parameters: { type: "object", properties: {} } as Tool["parameters"],
};

const zeroUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TOOL_BATCH_CLOSER_TEXT = "(Tool results delivered above. Continue.)";

function assistantToolCall(toolCallId: string, toolName: string): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
		api: "openai-completions",
		provider: "tokenharbor",
		model: "claude-sonnet-4.6",
		usage: zeroUsage,
		stopReason: "toolUse",
		endTurn: false,
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function markedMessageIndexes(sent: any[]): number[] {
	return sent.flatMap((message: any, index: number) =>
		Array.isArray(message.content)
			? message.content.filter((part: any) => part.cache_control).map(() => index)
			: [],
	);
}

async function captureSentMessages(context: Parameters<typeof complete>[1]): Promise<any[]> {
	await complete(gatewayModel("claude-sonnet-4.6"), context, { apiKey: "test" });
	return mockState.params.messages;
}

describe("openai-completions anthropic cache control", () => {
	beforeEach(() => {
		mockState.params = undefined;
	});

	it.each([
		"claude-sonnet-4.6",
		"anthropic/claude-sonnet-4.6",
		"vendor/anthropic-claude-x",
		"CLAUDE-OPUS-9.9",
		"claude-9-ultra",
	])("marks %s for caching on an unknown gateway", async (id) => {
		await complete(gatewayModel(id), context, { apiKey: "test" });

		const messages = mockState.params.messages;
		const system = messages.find((m: any) => m.role === "system" || m.role === "developer");
		expect(system?.content[0].cache_control).toEqual({ type: "ephemeral" });
		expect(messages.at(-1).content[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("does not mark non-Anthropic models", async () => {
		await complete(gatewayModel("deepseek-v4.1-flash"), context, { apiKey: "test" });

		const system = mockState.params.messages[0];
		expect(system.content[0].cache_control).toBeUndefined();
	});

	it("anchors a layered breakpoint in long conversations", async () => {
		const messages = Array.from({ length: 16 }, (_, index) => ({
			role: "user" as const,
			content: `message ${index}`,
			timestamp: Date.now(),
		}));

		await complete(
			gatewayModel("claude-sonnet-4.6"),
			{ ...context, messages },
			{ apiKey: "test" },
		);

		const sent = mockState.params.messages;
		const marked = sent.flatMap((message: any, index: number) =>
			Array.isArray(message.content)
				? message.content.filter((part: any) => part.cache_control).map(() => index)
				: [],
		);

		expect(marked.length).toBeGreaterThanOrEqual(3);
		expect(marked.length).toBeLessThanOrEqual(4);
		expect(marked.some((index: number) => index > 0 && index < sent.length - 1)).toBe(true);
	});

	it("marks the last tool alongside the system prompt", async () => {
		await complete(
			gatewayModel("claude-sonnet-4.6"),
			{ ...context, tools: [tool] },
			{ apiKey: "test" },
		);

		expect(mockState.params.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
	});

	describe("tool loop closers", () => {
		it("ends an in-flight tool-loop request with a marked closer and leaves tool messages unmarked", async () => {
			const sent = await captureSentMessages({
				systemPrompt: "you are a test",
				messages: [
					assistantToolCall("call_1", "bash"),
					toolResult("call_1", "bash", "big tool output"),
				],
				tools: [tool],
			});

			const tail = sent.at(-1);
			expect(tail.role).toBe("user");
			expect(tail.content[0].text).toBe(TOOL_BATCH_CLOSER_TEXT);
			expect(tail.content[0].cache_control).toEqual({ type: "ephemeral" });

			const toolMessages = sent.filter((message: any) => message.role === "tool");
			expect(toolMessages).toHaveLength(1);
			for (const toolMessage of toolMessages) {
				for (const part of Array.isArray(toolMessage.content) ? toolMessage.content : []) {
					expect(part.cache_control).toBeUndefined();
				}
			}

			// Breakpoint count.
			expect(markedMessageIndexes(sent)).toHaveLength(2);
			expect(mockState.params.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
		});

		it("marks the previous closer as the read anchor once the prefix grows", async () => {
			const sent = await captureSentMessages({
				systemPrompt: "you are a test",
				messages: [
					assistantToolCall("call_1", "bash"),
					toolResult("call_1", "bash", "first output"),
					assistantToolCall("call_2", "bash"),
					toolResult("call_2", "bash", "second output"),
				],
				tools: [tool],
			});

			const closers = sent.filter(
				(message: any) =>
					Array.isArray(message.content) &&
					message.content[0]?.text === TOOL_BATCH_CLOSER_TEXT,
			);
			expect(closers).toHaveLength(2);
			for (const closer of closers) {
				expect(closer.content[0].cache_control).toEqual({ type: "ephemeral" });
			}
			const tail = sent.at(-1);
			expect(tail.role).toBe("user");
			expect(tail.content[0].text).toBe(TOOL_BATCH_CLOSER_TEXT);

			// Breakpoint cap.
			expect(markedMessageIndexes(sent)).toHaveLength(3);
			expect(mockState.params.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
		});

		it("keeps a read anchor on the loop's last closer at the turn boundary", async () => {
			const sent = await captureSentMessages({
				systemPrompt: "you are a test",
				messages: [
					assistantToolCall("call_1", "bash"),
					toolResult("call_1", "bash", "loop output"),
					{ role: "user", content: "now answer in plain text", timestamp: Date.now() },
				],
				tools: [tool],
			});

			const tail = sent.at(-1);
			expect(tail.role).toBe("user");
			expect(tail.content[0].text).toBe("now answer in plain text");
			expect(tail.content[0].cache_control).toEqual({ type: "ephemeral" });

			const loopClosers = sent.filter(
				(message: any) =>
					Array.isArray(message.content) &&
					message.content[0]?.text === TOOL_BATCH_CLOSER_TEXT,
			);
			expect(loopClosers).toHaveLength(1);
			expect(loopClosers[0].content[0].cache_control).toEqual({ type: "ephemeral" });
		});

		it("keeps closer text constant so breakpoints align across growing requests", async () => {
			const firstRound = await captureSentMessages({
				systemPrompt: "you are a test",
				messages: [
					assistantToolCall("call_1", "bash"),
					toolResult("call_1", "bash", "round one"),
				],
				tools: [tool],
			});
			const secondRound = await captureSentMessages({
				systemPrompt: "you are a test",
				messages: [
					assistantToolCall("call_1", "bash"),
					toolResult("call_1", "bash", "round one"),
					assistantToolCall("call_2", "bash"),
					toolResult("call_2", "bash", "round two"),
				],
				tools: [tool],
			});

			const sharedPrefix = firstRound.map((message: any) => JSON.stringify(message));
			const grownPrefix = secondRound
				.slice(0, firstRound.length)
				.map((message: any) => JSON.stringify(message));
			expect(grownPrefix).toEqual(sharedPrefix);
		});
	});
});
