import type { CredentialStore, Model } from "@huranth/gama-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

export const testAnthropicModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

// Provider.
export function registerTestAnthropicProvider(registry: ModelRegistry): void {
	registry.registerProvider("anthropic", {
		baseUrl: "https://api.anthropic.com",
		apiKey: "test-key",
		api: "anthropic-messages",
		models: [
			{
				id: testAnthropicModel.id,
				name: testAnthropicModel.name,
				reasoning: true,
				input: ["text"],
				cost: testAnthropicModel.cost,
				contextWindow: 200_000,
				maxTokens: 8192,
			},
		],
	});
}

export async function createModelRegistry(
	credentials: CredentialStore,
	modelsPath?: string,
): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			includeBuiltinProviders: true,
		}),
	);
}

export async function createInMemoryModelRegistry(
	credentials: CredentialStore,
): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
			includeBuiltinProviders: true,
		}),
	);
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}
