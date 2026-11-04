import { describe, expect, it } from "vitest";
import { stream } from "../src/wire/mistral-conversations.ts";
import type { Context, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"mistral-conversations"> = {
	id: "mistral-large-latest",
	name: "Mistral Large",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

function makeContext(): TranscriptContext {
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	return normalizeContext(context);
}

function sseResponse(...events: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
			controller.close();
		},
	});

	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function runStream(fetchStub: typeof globalThis.fetch) {
	const result = stream(model, makeContext(), { apiKey: "test", fetch: fetchStub });

	return result.result();
}

describe("mistral stream events", () => {
	it("repairs a control character instead of failing the stream", async () => {
		const message = await runStream(async () =>
			sseResponse(
				'{"choices":[{"delta":{"content":"tab\there"}}]}',
				'{"choices":[{"delta":{},"finish_reason":"stop"}]}',
			),
		);

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "tab\there" }]);
	});

	it("fails with the payload when the event JSON cannot be parsed", async () => {
		const message = await runStream(async () => sseResponse('{"choices":[}'));

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Malformed stream event");
		expect(message.errorMessage).toContain('{"choices":[}');
	});

	it("surfaces the HTTP body on a refused request", async () => {
		const message = await runStream(
			async () =>
				new Response('{"error":"blocked by gateway WAF"}', {
					status: 403,
					statusText: "Forbidden",
				}),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe(
			'Mistral API error (403): {"error":"blocked by gateway WAF"}',
		);
	});
});
