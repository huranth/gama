import { describe, expect, it } from "vitest";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { streamSimple as streamAnthropic } from "../src/wire/anthropic-messages.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "test-provider",
	baseUrl: "https://upstream.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function sseResponse(events: unknown[], sentinels: string[] = []): FetchFunction {
	return async () => {
		const text = [
			...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
			...sentinels.map((data) => `data: ${data}\n\n`),
		].join("");
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		});
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
}

function textEvents(text: string): unknown[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: model.id,
				content: [],
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
}

function startStream(fetch: FetchFunction) {
	return streamAnthropic(model, context, {
		apiKey: "test-key",
		fetch,
		maxRetries: 0,
	}).result();
}

describe("anthropic data-only SSE events", () => {
	it("parses a stream that omits event lines", async () => {
		const message = await startStream(sseResponse(textEvents("hello")));

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(message.content).toContainEqual({ type: "text", text: "hello" });
	});

	it("surfaces an error payload that omits the event line", async () => {
		const message = await startStream(
			sseResponse([
				{
					type: "error",
					error: { type: "overloaded_error", message: "upstream overloaded" },
				},
			]),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("upstream overloaded");
	});

	it("ignores a DONE sentinel after the final event", async () => {
		const message = await startStream(sseResponse(textEvents("hello"), ["[DONE]"]));

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(message.content).toContainEqual({ type: "text", text: "hello" });
	});
});
