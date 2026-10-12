import { createProvider, type Model } from "@huranth/gama-ai";
import { complete, getApiProvider, resetApiProviders } from "@huranth/gama-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

interface CapturedRequest {
	url: string;
	headers: Headers;
}

function createCapturingFetch(): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, headers: request.headers });
		const chunk = {
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "test",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { fetch, requests };
}

const CLOUDFLARE_GATEWAY_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat";
const CLOUDFLARE_COMPAT_URL = `${CLOUDFLARE_GATEWAY_BASE_URL}/chat/completions`;

function cloudflareGatewayModel(): Model<"openai-completions"> {
	return {
		id: "workers-ai/@cf/moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		provider: "cloudflare-ai-gateway",
		baseUrl: CLOUDFLARE_GATEWAY_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 256000,
	};
}

async function createCloudflareRuntime(): Promise<{
	modelRuntime: ModelRuntime;
	modelRegistry: ModelRegistry;
}> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
	}));
	const streams = getApiProvider("openai-completions");
	if (!streams) throw new Error("openai-completions API provider is not registered.");
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		includeBuiltinProviders: true,
	});
	modelRuntime.registerNativeProvider(
		createProvider({
			id: "cloudflare-ai-gateway",
			name: "Cloudflare AI Gateway",
			auth: {
				apiKey: {
					name: "Cloudflare AI Gateway token",
					resolve: async ({ credential }) =>
						credential?.key
							? {
									auth: {
										headers: {
											"cf-aig-authorization": `Bearer ${credential.key}`,
											Authorization: null,
											"x-api-key": null,
										},
									},
									source: "stored credential",
								}
							: undefined,
				},
			},
			models: [cloudflareGatewayModel()],
			api: streams,
		}),
	);
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel(
			"cloudflare-ai-gateway",
			"workers-ai/@cf/moonshotai/kimi-k2.6",
		);
		expect(model).toBeDefined();

		resetApiProviders();
		const { fetch, requests } = createCapturingFetch();
		const result = await modelRuntime.completeSimple(model!, { messages: [] }, { fetch });

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(CLOUDFLARE_COMPAT_URL);
		expect(requests[0].headers.get("cf-aig-authorization")).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find(
			"cloudflare-ai-gateway",
			"workers-ai/@cf/moonshotai/kimi-k2.6",
		);
		expect(model).toBeDefined();

		resetApiProviders();
		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);
		expect(auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer test-token",
			Authorization: null,
			"x-api-key": null,
		});

		const { fetch, requests } = createCapturingFetch();
		const result = await complete(model!, { messages: [] }, { ...auth, fetch });

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(CLOUDFLARE_COMPAT_URL);
		expect(requests[0].headers.get("cf-aig-authorization")).toBe("Bearer test-token");
		expect(requests[0].headers.has("authorization")).toBe(false);
		expect(requests[0].headers.has("x-api-key")).toBe(false);
	});
});
