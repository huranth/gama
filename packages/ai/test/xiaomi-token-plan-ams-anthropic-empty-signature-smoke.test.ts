import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeSimple, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

let server: Server;
let baseUrl: string;

const model: Model<"anthropic-messages"> = {
	id: "mimo-v2.5-pro",
	name: "MiMo-V2.5-Pro Anthropic smoke",
	api: "anthropic-messages",
	provider: "xiaomi-token-plan-ams",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 1024,
	compat: { allowEmptySignature: true },
};

const apiKey = "test-key";

interface AnthropicPayload {
	messages?: Array<{
		role: string;
		content:
			| string
			| Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
	}>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeInitialContext(): Context {
	return {
		systemPrompt: "You are concise. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Think internally if you need to, then reply with exactly this text " +
					"and nothing else: first-ok",
				timestamp: Date.now(),
			},
		],
	};
}

function getThinkingBlocks(message: AssistantMessage) {
	return message.content.filter((block) => block.type === "thinking");
}

async function captureReplayPayload(context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey,
		maxTokens: 512,
		reasoning: "high",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload capture before request");
	}
	return capturedPayload;
}

// Empty signature.
function thinkingThenTextEvents(): unknown[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_smoke",
				type: "message",
				role: "assistant",
				model: model.id,
				content: [],
				usage: { input_tokens: 12, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "thinking_delta", thinking: "internal reasoning" },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "first-ok" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
		{ type: "message_stop" },
	];
}

beforeAll(async () => {
	server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.statusCode = 200;
			response.setHeader("content-type", "text/event-stream");
			for (const event of thinkingThenTextEvents()) {
				response.write(
					`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
				);
			}
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${address.port}`;
	model.baseUrl = baseUrl;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Xiaomi Token Plan AMS Anthropic empty thinking signature smoke", () => {
	it(
		"reproduces empty thinking signatures and preserves them for replay",
		{ timeout: 60000 },
		async () => {
			const firstContext = makeInitialContext();
			const first = await completeSimple(model, firstContext, {
				apiKey,
				maxTokens: 512,
				reasoning: "high",
			});

			expect(first.stopReason, first.errorMessage).toBe("stop");

			const thinkingBlocks = getThinkingBlocks(first);
			expect(thinkingBlocks.length).toBeGreaterThan(0);
			expect(thinkingBlocks.some((block) => block.thinkingSignature === "")).toBe(true);

			const replayContext: Context = {
				...firstContext,
				messages: [
					...firstContext.messages,
					first,
					{
						role: "user",
						content: "Reply with exactly this text and nothing else: second-ok",
						timestamp: Date.now(),
					},
				],
			};

			const replayPayload = await captureReplayPayload(replayContext);
			const assistantPayload = replayPayload.messages?.find(
				(message) => message.role === "assistant",
			);
			expect(assistantPayload).toBeDefined();
			expect(Array.isArray(assistantPayload!.content)).toBe(true);
			const replayedThinking = (
				assistantPayload!.content as Array<{ type: string; text?: string }>
			).filter((block) => block.type === "thinking");
			const replayedText = (
				assistantPayload!.content as Array<{ type: string; text?: string }>
			).filter((block) => block.type === "text");
			expect(replayedThinking).toEqual([
				{ type: "thinking", thinking: thinkingBlocks[0].thinking, signature: "" },
			]);
			expect(replayedText.some((block) => block.text === thinkingBlocks[0].thinking)).toBe(
				false,
			);
		},
	);
});
