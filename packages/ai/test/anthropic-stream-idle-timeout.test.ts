import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

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

afterEach(() => {
	vi.useRealTimers();
});

const stalled: FetchFunction = async () =>
	new Response(new ReadableStream<Uint8Array>({}), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});

function startStalledStream(timeoutMs?: number) {
	return streamAnthropic(model, context, {
		apiKey: "test-key",
		fetch: stalled,
		maxRetries: 0,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	}).result();
}

describe("anthropic stream idle timeout", () => {
	it("fails a stalled response body with a retryable error", async () => {
		vi.useFakeTimers();
		const pending = startStalledStream();
		await vi.advanceTimersByTimeAsync(120_000);
		const message = await pending;

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/idle timeout/);
		expect(isRetryableAssistantError(fauxAssistantMessage("", message))).toBe(true);
	});

	it("uses options.timeoutMs instead of the default", async () => {
		vi.useFakeTimers();
		let settled = false;
		const pending = startStalledStream(300_000).then((message) => {
			settled = true;
			return message;
		});
		await vi.advanceTimersByTimeAsync(299_000);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		const message = await pending;

		expect(message.errorMessage).toContain("300000ms");
	});

	it("does not time out when timeoutMs is 0", async () => {
		vi.useFakeTimers();
		let settled = false;
		void startStalledStream(0).then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(3_600_000);

		expect(settled).toBe(false);
	});
});
