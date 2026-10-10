import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CUSTOM_PROVIDER_API,
	rememberCustomProviderModel,
	resolveModels,
	saveCustomProviderModels,
	saveModelOverride,
	saveProviderBaseUrl,
} from "../src/core/custom-provider.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const cleanupDirs: string[] = [];

afterEach(() => {
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("custom provider persistence", () => {
	it("loads a saved provider with its models available", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-custom-persist-"));
		cleanupDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		const authPath = join(dir, "auth.json");

		const resolved = resolveModels([
			{
				id: "deepseek-v4",
				name: "DeepSeek V4",
				contextWindow: 128_000,
				maxTokens: 8192,
				input: ["text"],
			},
		]);
		const definitions = resolved.map((model) => ({
			id: model.id,
			name: model.name,
			input: model.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));

		await saveCustomProviderModels(modelsPath, "tokenharbor", {
			name: "tokenharbor",
			baseUrl: "https://tokenharbor.ai/v1",
			api: CUSTOM_PROVIDER_API,
			models: definitions,
		});
		const auth = AuthStorage.create(authPath);
		await auth.modify("tokenharbor", async () => ({ type: "api_key", key: "sk-test" }));

		const runtime = await ModelRuntime.create({
			credentials: auth,
			modelsPath,
			refreshOnCreate: false,
		});
		await runtime.refresh({ allowNetwork: false, providers: ["tokenharbor"] });

		const available = runtime
			.getAvailableSnapshot()
			.filter((model) => model.provider === "tokenharbor");
		expect(available.map((model) => model.id)).toContain("deepseek-v4");
		const model = runtime.getModel("tokenharbor", "deepseek-v4");
		expect(model?.baseUrl).toBe("https://tokenharbor.ai/v1");
		expect(model?.api).toBe(CUSTOM_PROVIDER_API);
		expect(model?.contextWindow).toBe(128_000);
		expect(model?.maxTokens).toBe(8192);
	});

	it("repoints an existing provider without losing its models", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-custom-repoint-"));
		cleanupDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		const authPath = join(dir, "auth.json");

		await saveCustomProviderModels(modelsPath, "tokenharbor", {
			name: "tokenharbor",
			baseUrl: "https://tokenharbor.ai/v1",
			api: CUSTOM_PROVIDER_API,
			models: [
				{
					id: "deepseek-v4",
					name: "DeepSeek V4",
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					reasoning: false,
					contextWindow: 128_000,
					maxTokens: 8192,
				},
			],
		});
		await saveModelOverride(modelsPath, "tokenharbor", "deepseek-v4", { contextWindow: 200_000 });

		await saveProviderBaseUrl(modelsPath, "tokenharbor", "https://proxy.example.com/v1");

		const saved = JSON.parse(await readFile(modelsPath, "utf-8"));
		expect(saved.providers.tokenharbor.baseUrl).toBe("https://proxy.example.com/v1");
		expect(saved.providers.tokenharbor.api).toBe(CUSTOM_PROVIDER_API);
		expect(saved.providers.tokenharbor.models).toHaveLength(1);
		expect(saved.providers.tokenharbor.modelOverrides["deepseek-v4"].contextWindow).toBe(200_000);

		const auth = AuthStorage.create(authPath);
		await auth.modify("tokenharbor", async () => ({ type: "api_key", key: "sk-test" }));

		const runtime = await ModelRuntime.create({
			credentials: auth,
			modelsPath,
			refreshOnCreate: false,
		});
		await runtime.refresh({ allowNetwork: false, providers: ["tokenharbor"] });

		// Reload.
		expect(runtime.getModel("tokenharbor", "deepseek-v4")?.baseUrl).toBe(
			"https://proxy.example.com/v1",
		);
		expect(runtime.getModel("tokenharbor", "deepseek-v4")?.contextWindow).toBe(200_000);
	});

	it("persists a per-model contextWindow override and " + "reapplies it on reload", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-custom-override-"));
		cleanupDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		const authPath = join(dir, "auth.json");

		await saveCustomProviderModels(modelsPath, "tokenharbor", {
			name: "tokenharbor",
			baseUrl: "https://tokenharbor.ai/v1",
			api: CUSTOM_PROVIDER_API,
			models: [
				{
					id: "deepseek-v4",
					name: "DeepSeek V4",
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					reasoning: false,
					contextWindow: 100_000,
					maxTokens: 8192,
				},
			],
		});
		const auth = AuthStorage.create(authPath);
		await auth.modify("tokenharbor", async () => ({ type: "api_key", key: "sk-test" }));

		const runtime = await ModelRuntime.create({
			credentials: auth,
			modelsPath,
			refreshOnCreate: false,
		});
		await runtime.refresh({ allowNetwork: false, providers: ["tokenharbor"] });
		expect(runtime.getModel("tokenharbor", "deepseek-v4")?.contextWindow).toBe(100_000);

		await saveModelOverride(modelsPath, "tokenharbor", "deepseek-v4", {
			contextWindow: 1_000_000,
		});
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel("tokenharbor", "deepseek-v4")?.contextWindow).toBe(1_000_000);

		const raw = JSON.parse(await readFile(modelsPath, "utf-8"));
		expect(raw.providers.tokenharbor.models[0].contextWindow).toBe(100_000);
		expect(raw.providers.tokenharbor.modelOverrides["deepseek-v4"].contextWindow).toBe(1_000_000);
	});

	it(
		"remembers a picked model the local snapshot lacks so " + "it resolves next launch",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "gama-custom-remember-"));
			cleanupDirs.push(dir);
			const modelsPath = join(dir, "models.json");
			const authPath = join(dir, "auth.json");

			await saveCustomProviderModels(modelsPath, "tokenharbor", {
				name: "tokenharbor",
				baseUrl: "https://tokenharbor.ai/v1",
				api: CUSTOM_PROVIDER_API,
				models: [
					{
						id: "deepseek-v4",
						name: "DeepSeek V4",
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						reasoning: false,
						contextWindow: 100_000,
						maxTokens: 8192,
					},
				],
			});
			const auth = AuthStorage.create(authPath);
			await auth.modify("tokenharbor", async () => ({ type: "api_key", key: "sk-test" }));

			const picked = {
				provider: "tokenharbor",
				id: "claude-haiku-5.5:free",
				name: "Claude Haiku 5.5",
				api: CUSTOM_PROVIDER_API,
				baseUrl: "https://tokenharbor.ai/v1",
				input: ["text"] as ("text" | "image")[],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 200000,
				maxTokens: 8192,
			};

			expect(await rememberCustomProviderModel(modelsPath, picked)).toBe("added");
			expect(await rememberCustomProviderModel(modelsPath, picked)).toBe("already-known");
			expect(
				await rememberCustomProviderModel(modelsPath, {
					...picked,
					provider: "anthropic",
					id: "claude-x",
				}),
			).toBe("not-custom");

			const raw = JSON.parse(await readFile(modelsPath, "utf-8"));
			expect(raw.providers.tokenharbor.models.map((m: { id: string }) => m.id)).toEqual([
				"deepseek-v4",
				"claude-haiku-5.5:free",
			]);

			const runtime = await ModelRuntime.create({
				credentials: auth,
				modelsPath,
				refreshOnCreate: false,
			});
			await runtime.refresh({ allowNetwork: false, providers: ["tokenharbor"] });
			expect(runtime.getModel("tokenharbor", "claude-haiku-5.5:free")?.contextWindow).toBe(
				200000,
			);
		},
	);
});
