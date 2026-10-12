import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

describe("models.json cache configuration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("passes per-model cache settings through to the composed model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-cache-config-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"cache-gateway": {
						baseUrl: "https://api.example.com/v1",
						api: "openai-completions",
						models: [
							{
								id: "cached-model",
								name: "Cached Model",
								input: ["text"],
								cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
								reasoning: true,
								contextWindow: 200_000,
								maxTokens: 32_000,
								promptCache: { short: 600 },
								compat: { cacheControlFormat: "anthropic", sendPromptCacheKey: true },
							},
						],
					},
				},
			}),
		);

		const config = await ModelConfig.load(modelsPath);
		const provider = composeModelProvider("cache-gateway", undefined, config, undefined);
		const composed = provider.getModels().find((entry) => entry.id === "cached-model");

		const compat = composed?.compat as
			| { cacheControlFormat?: string; sendPromptCacheKey?: boolean }
			| undefined;

		expect(composed?.promptCache?.short).toBe(600);
		expect(compat?.cacheControlFormat).toBe("anthropic");
		expect(compat?.sendPromptCacheKey).toBe(true);
	});

	it("lets a provider disable auto-detected cache_control markers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-cache-config-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"plain-gateway": {
						baseUrl: "https://openai-compatible.example.com/v1",
						api: "openai-completions",
						models: [
							{
								id: "claude-like-name",
								name: "Gateway Model",
								input: ["text"],
								reasoning: true,
								compat: { cacheControlFormat: "none" },
							},
						],
					},
				},
			}),
		);

		const config = await ModelConfig.load(modelsPath);
		const provider = composeModelProvider("plain-gateway", undefined, config, undefined);
		const composed = provider.getModels().find((entry) => entry.id === "claude-like-name");

		const compat = composed?.compat as { cacheControlFormat?: string } | undefined;

		expect(compat?.cacheControlFormat).toBe("none");
	});
});
