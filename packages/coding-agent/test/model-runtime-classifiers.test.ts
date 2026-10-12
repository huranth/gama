import { type ClassifierModel, createProvider, InMemoryModelsStore } from "@huranth/gama-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const context = {
	state: { text: "Looks good" },
	questions: {
		approved: {
			type: "bool" as const,
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

function jevModel(): ClassifierModel<"typesafe-system-one"> {
	return {
		type: "classifier",
		id: "jev-latest",
		name: "Jev (latest)",
		api: "typesafe-system-one",
		provider: "typesafe",
		baseUrl: "https://api.typesafe.ai/v1/",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	};
}

describe("ModelRuntime classifiers", () => {
	it("lists Jev separately and classifies with runtime-resolved auth", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			includeBuiltinProviders: true,
		});
		const observed: Array<{ apiKey: string | undefined; headers: unknown }> = [];
		runtime.registerNativeProvider(
			createProvider({
				id: "typesafe",
				auth: {
					apiKey: {
						name: "Typesafe key",
						resolve: async ({ credential }) =>
							credential?.key
								? { auth: { apiKey: credential.key }, source: "stored credential" }
								: undefined,
					},
				},
				models: [jevModel()],
				classifiers: {
					"typesafe-system-one": {
						classify: async (model, _classifierContext, options) => {
							observed.push({ apiKey: options?.apiKey, headers: options?.headers });
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								answers: { approved: { type: "bool", probability: 0.8 } },
								stopReason: "stop",
								timestamp: 0,
							};
						},
					},
				},
			}),
		);

		const jev = runtime.getModelOfType("classifier", "typesafe", "jev-latest")!;
		expect(jev.type).toBe("classifier");
		expect(runtime.getModel("typesafe", "jev-latest")).toBeUndefined();

		const unconfigured = await runtime.classify(jev, context);
		expect(unconfigured.stopReason).toBe("error");
		expect(unconfigured.errorMessage).toContain("not configured");

		await runtime.setRuntimeApiKey("typesafe", "sk-typesafe");
		expect(await runtime.getAvailableOfType("classifier", "typesafe")).toEqual([jev]);
		const result = await runtime.classify(jev, context);
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
		expect(observed).toEqual([{ apiKey: "sk-typesafe", headers: undefined }]);
	});
});
