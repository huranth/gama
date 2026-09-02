import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Model, ProviderResponse } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve, reject) => {
		server?.close((error) => (error ? reject(error) : resolve()));
	});
	server = undefined;
});

async function startBedrockResponseServer(): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "application/vnd.amazon.eventstream",
			"x-bifrost-provider": "bedrock",
			"x-bifrost-resolved-model": MODEL_ID,
			"x-amzn-requestid": "req-123",
		});
		res.end();
	});

	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
	return `http://127.0.0.1:${address.port}`;
}

describe("bedrock response headers", () => {
	it("forwards raw Smithy response headers to onResponse", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			id: MODEL_ID,
			name: "Claude Haiku 4.5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: await startBedrockResponseServer(),
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
		const responses: ProviderResponse[] = [];

		const result = await streamBedrock(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			}),
			{
				cacheRetention: "none",
				env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1" },
				onResponse: (response) => {
					responses.push(response);
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(responses).toHaveLength(1);
		expect(responses[0].status).toBe(200);
		expect(responses[0].headers["x-amzn-requestid"]).toBe("req-123");
		expect(responses[0].headers["x-bifrost-provider"]).toBe("bedrock");
		expect(responses[0].headers["x-bifrost-resolved-model"]).toBe(MODEL_ID);
	});
});
