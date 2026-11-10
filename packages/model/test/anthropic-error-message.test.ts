import { describe, expect, it } from "vitest";
import type { Context, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { stream } from "../src/wire/anthropic-messages.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function makeContext(): TranscriptContext {
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	return normalizeContext(context);
}

describe("anthropic error messages", () => {
	it("formats a thrown non-Error value instead of leaving the message empty", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		const message = await stream(model, makeContext(), {
			apiKey: "test",
			onPayload: () => {
				throw circular;
			},
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("[object Object]");
	});

	it("keeps the SDK message and status for a real error", async () => {
		const failure = Object.assign(new Error("blocked by gateway WAF"), {
			status: 403,
			error: { error: "blocked by gateway WAF" },
		});

		const message = await stream(model, makeContext(), {
			apiKey: "test",
			onPayload: () => {
				throw failure;
			},
		}).result();

		expect(message.errorMessage).toBe('403: {"error":"blocked by gateway WAF"}');
	});
});
