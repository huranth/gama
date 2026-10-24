import { Agent } from "@huranth/gama-agent-core";
import { createProvider, envApiKeyAuth, type Model } from "@huranth/gama-ai";
import { openAICompletionsApi } from "@huranth/gama-ai/api/openai-completions.lazy";
import { createModels } from "@huranth/gama-ai/models";

const baseUrl = "https://example.test/v1";
const model: Model<"openai-completions"> = {
	id: "smoke-model",
	name: "smoke-model",
	api: "openai-completions",
	provider: "smoke",
	baseUrl,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 8_192,
};

const models = createModels();
models.setProvider(
	createProvider({
		id: "smoke",
		name: "Smoke",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("SMOKE_API_KEY", ["SMOKE_API_KEY"]) },
		api: openAICompletionsApi(),
		models: [model],
	}),
);
const resolved = models.getModel("smoke", "smoke-model");
if (!resolved) throw new Error("Smoke-test model not found");

export const agent = new Agent({
	initialState: { model: resolved },
	streamFn: models.streamSimple.bind(models),
});
