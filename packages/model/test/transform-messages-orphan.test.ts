import type { Model, ToolResultMessage } from "../src/types.ts";
import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/wire/transform-messages.ts";

const model: Model<"openai-responses"> = {
	id: "test",
	name: "Test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000,
	maxTokens: 1_000,
};

const orphan = {
	role: "toolResult",
	toolCallId: "missing",
	toolName: "lookup",
	content: [{ type: "text", text: "orphan" }],
	isError: false,
	timestamp: 0,
} as ToolResultMessage;

const assistant = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call", name: "lookup", arguments: {} }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 0,
} as const;

describe("transformMessages", () => {
	it("drops a tool result that matches no pending call", () => {
		const answer = { ...orphan, toolCallId: "call" } as ToolResultMessage;
		const result = transformMessages([assistant as never, answer, orphan], model);
		expect(result).toHaveLength(2);
		expect(
			result.some(
				(message) => message.role === "toolResult" && message.toolCallId === "missing",
			),
		).toBe(false);
	});

	it("keeps a tool result that answers the pending call", () => {
		const result = { ...orphan, toolCallId: "call" } as ToolResultMessage;
		expect(transformMessages([assistant as never, result], model)).toHaveLength(2);
	});
});
