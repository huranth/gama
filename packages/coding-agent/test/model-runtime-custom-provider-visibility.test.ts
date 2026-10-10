import type { Model, Provider } from "@huranth/gama-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderModelConfig } from "../src/core/provider-composer.ts";

const MODEL_ID = "glm-5.3";

function modelDefinition(): ProviderModelConfig {
	return {
		id: MODEL_ID,
		name: MODEL_ID,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 },
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 131_072,
	};
}

function providerModel(providerId: string): Model<"openai-completions"> {
	return {
		id: MODEL_ID,
		name: MODEL_ID,
		api: "openai-completions",
		provider: providerId,
		baseUrl: "https://gateway.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 200_000,
		maxTokens: 131_072,
	};
}

function nativeProvider(
	id: string,
	options: {
		authValid?: () => boolean;
	} = {},
): Provider<"openai-completions"> {
	const model = providerModel(id);
	return {
		id,
		name: id,
		baseUrl: "https://gateway.test/v1",
		auth: {
			apiKey: {
				name: "API key",
				check: async ({ credential }) =>
					(options.authValid?.() ?? true) && credential
						? { type: "api_key", source: "stored" }
						: undefined,
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

function availableProviders(runtime: ModelRuntime): Set<string> {
	return new Set(runtime.getAvailableSnapshot().map((model) => model.provider));
}

describe("model runtime custom provider visibility", () => {
	it("keeps authenticated models when a catalog refresh fails", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				tokenharbor: { type: "api_key", key: "sk-test" },
			}),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerProvider("tokenharbor", {
			name: "tokenharbor",
			baseUrl: "https://gateway.test/v1",
			api: "openai-completions",
			models: [modelDefinition()],
			refreshModels: async (context) => {
				if (context.allowNetwork) {
					throw new Error("catalog endpoint unavailable");
				}
				return [modelDefinition()];
			},
		});
		await runtime.refresh({ allowNetwork: false });
		expect(availableProviders(runtime).has("tokenharbor")).toBe(true);

		await runtime.refresh({ allowNetwork: true });

		expect(availableProviders(runtime).has("tokenharbor")).toBe(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.id === MODEL_ID)).toBe(true);
		// Separate failures.
		expect(runtime.getError() ?? "").not.toContain("unreachable");
	});

	it("does not expose a stored-but-unconfirmed provider before auth is rechecked", async () => {
		const credentials = AuthStorage.inMemory({
			aetherapi: { type: "api_key", key: "sk-test" },
		});
		let authValid = true;
		const provider = nativeProvider("aetherapi", { authValid: () => authValid });
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
		});

		runtime.registerNativeProvider(provider);
		await runtime.refresh({ allowNetwork: false });
		expect(availableProviders(runtime).has("aetherapi")).toBe(true);

		authValid = false;
		await runtime.refresh({ allowNetwork: false });
		expect(availableProviders(runtime).has("aetherapi")).toBe(false);

		// Credentials unconfirmed.
		runtime.registerNativeProvider(provider);
		expect(availableProviders(runtime).has("aetherapi")).toBe(false);

		await runtime.refresh({ allowNetwork: false });
		expect(availableProviders(runtime).has("aetherapi")).toBe(false);
	});
});
