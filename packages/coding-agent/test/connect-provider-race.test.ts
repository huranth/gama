import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@huranth/gama-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { saveCustomProviderModels } from "../src/core/custom-provider.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ProviderModelConfig } from "../src/core/provider-composer.ts";

const cleanupDirs: string[] = [];

afterEach(() => {
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const MODEL_DEFS: ProviderModelConfig[] = [
	{
		id: "m1",
		name: "m1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
];

async function freshRuntime(dir: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

async function connectLikeDialog(runtime: ModelRuntime, dir: string): Promise<void> {
	// Mirror connect
	runtime.registerProvider("newprov", {
		name: "newprov",
		baseUrl: "https://newprov.example/v1",
		apiKey: "sk-test",
		api: "openai-completions",
		models: MODEL_DEFS,
	});
	await runtime.refresh({ allowNetwork: false, providers: ["newprov"] });

	await saveCustomProviderModels(join(dir, "models.json"), "newprov", {
		name: "newprov",
		baseUrl: "https://newprov.example/v1",
		api: "openai-completions",
		models: MODEL_DEFS,
	});
	const authStorage = AuthStorage.create(join(dir, "auth.json"));
	await authStorage.modify("newprov", async () => ({ type: "api_key", key: "sk-test" }));
}

describe("connect provider persistence", () => {
	it("provider stays in the snapshot after the connect-time refresh", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-connect-race-"));
		cleanupDirs.push(dir);
		writeFileSync(join(dir, "models.json"), JSON.stringify({}, null, 2));
		const runtime = await freshRuntime(dir);

		await connectLikeDialog(runtime, dir);

		const providers = new Set(runtime.getAvailableSnapshot().map((m) => m.provider));
		expect(providers.has("newprov")).toBe(true);
	});

	it("provider is visible to a fresh runtime (restart simulate)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-connect-restart-"));
		cleanupDirs.push(dir);
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }, null, 2));
		const runtime = await freshRuntime(dir);
		await connectLikeDialog(runtime, dir);

		// Simulate restart
		const fresh = await freshRuntime(dir);
		await fresh.refresh({ allowNetwork: false });

		const providers = new Set(fresh.getAvailableSnapshot().map((m) => m.provider));
		expect(providers.has("newprov")).toBe(true);
	});

	it("provider survives a full /model-style refresh right after connect (real env)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-connect-full-"));
		cleanupDirs.push(dir);
		// Existing gateway
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify(
				{
					providers: {
						tokenharbor: {
							name: "tokenharbor",
							baseUrl: "https://tokenharbor.ai/v1",
							api: "openai-completions",
							models: [
								{
									id: "glm-5.3",
									name: "glm-5.3",
									input: ["text"],
									cost: { input: 1.4, output: 4.4, cacheRead: 0.283, cacheWrite: 1.4 },
									reasoning: true,
									contextWindow: 200000,
									maxTokens: 131072,
								},
							],
						},
					},
				},
				null,
				2,
			),
		);
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		await authStorage.modify("tokenharbor", async () => ({
			type: "api_key",
			key: "th-test",
		}));

		const runtime = await freshRuntime(dir);
		await connectLikeDialog(runtime, dir);

		// Full refresh
		await runtime.refresh({ allowNetwork: false });

		const providers = new Set(runtime.getAvailableSnapshot().map((m) => m.provider));
		expect(providers.has("newprov")).toBe(true);
		expect(providers.has("tokenharbor")).toBe(true);
	});
});
