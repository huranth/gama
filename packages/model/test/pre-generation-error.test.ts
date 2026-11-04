import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/wire/anthropic-messages.ts";
import { streamSimple as streamAzure } from "../src/wire/azure-openai-responses.ts";
import { streamSimple as streamGoogle } from "../src/wire/google-generative-ai.ts";
import { streamSimple as streamMistral } from "../src/wire/mistral-conversations.ts";
import { streamSimple as streamCodex } from "../src/wire/openai-codex-responses.ts";
import { streamSimple as streamOpenAICompletions } from "../src/wire/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../src/wire/openai-responses.ts";
import type { Api, ReplyStream, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test",
		api,
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function expectMissingAuthThrows(create: () => ReplyStream): void {
	expect(create).toThrow("No API key: test-provider");
}

describe("direct API authentication", () => {
	it("throws synchronously when auth is missing", () => {
		const context = normalizeContext({ messages: [] });
		expectMissingAuthThrows(() => streamAnthropic(model("anthropic-messages"), context, {}));
		expectMissingAuthThrows(() => streamAzure(model("azure-openai-responses"), context, {}));
		expectMissingAuthThrows(() => streamGoogle(model("google-generative-ai"), context, {}));
		expectMissingAuthThrows(() => streamMistral(model("mistral-conversations"), context, {}));
		expectMissingAuthThrows(() => streamCodex(model("openai-codex-responses"), context, {}));
		expectMissingAuthThrows(() =>
			streamOpenAICompletions(model("openai-completions"), context, {}),
		);
		expectMissingAuthThrows(() => streamOpenAIResponses(model("openai-responses"), context, {}));
	});
});
