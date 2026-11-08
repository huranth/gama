import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import type { ProviderChatModelConfig } from "../src/core/provider-composer.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const SAVED_MODEL: ProviderChatModelConfig = {
	id: "saved-only",
	name: "Saved Only",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 8_192,
};

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function publishContext(overrides: Record<string, unknown> = {}) {
	return {
		credential: { type: "api_key" as const, key: "test-key" },
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication: { update?: () => void }) => {
			publication.update?.();
			return true;
		},
		...overrides,
	};
}

async function emptyConfig(): Promise<ModelConfig> {
	return ModelConfig.load(undefined);
}

describe("custom endpoint live refresh", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		vi.unstubAllGlobals();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function configWithModelsJson(entry: unknown): Promise<ModelConfig> {
		const dir = mkdtempSync(join(tmpdir(), "gama-models-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { "models-gateway": entry } }));
		return ModelConfig.load(modelsPath);
	}

	it("composes a live refresh for baseUrl providers; static ones stay fixed", async () => {
		const config = await emptyConfig();
		const live = composeModelProvider("live-gateway", undefined, config, {
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [SAVED_MODEL],
		});
		expect(typeof live.refreshModels).toBe("function");

		const fixed = composeModelProvider("static-list", undefined, config, {
			apiKey: "test-key",
			api: "openai-completions",
		});
		expect(fixed.refreshModels).toBeUndefined();
	});

	it("fetches the endpoint catalog live and replaces the saved list", async () => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
				seen.push(String(url));
				expect(init?.headers?.Authorization).toBe("Bearer test-key");
				return jsonResponse({ data: [{ id: "live-a" }, { id: "live-b" }] });
			}),
		);
		const config = await emptyConfig();
		const provider = composeModelProvider("live-gateway", undefined, config, {
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [SAVED_MODEL],
		});

		expect(provider.getModels().map((model) => model.id)).toContain("saved-only");
		await provider.refreshModels?.(publishContext() as never);
		expect(seen).toEqual(["https://api.example.com/v1/models"]);
		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("live-a");
		expect(ids).toContain("live-b");
		expect(ids).not.toContain("saved-only");
	});

	it("keeps the saved list when offline, unauthenticated, or aborted", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: "live-a" }] }));
		vi.stubGlobal("fetch", fetchMock);
		const config = await emptyConfig();
		const provider = composeModelProvider("live-gateway", undefined, config, {
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [SAVED_MODEL],
		});

		await provider.refreshModels?.(publishContext({ allowNetwork: false }) as never);
		await provider.refreshModels?.(publishContext({ credential: undefined }) as never);
		const controller = new AbortController();
		controller.abort();
		await provider.refreshModels?.(publishContext({ signal: controller.signal }) as never);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(provider.getModels().map((model) => model.id)).toEqual(["saved-only"]);
	});

	it("surfaces endpoint failures instead of silently keeping stale models", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "nope" }, 500)),
		);
		const config = await emptyConfig();
		const provider = composeModelProvider("live-gateway", undefined, config, {
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [SAVED_MODEL],
		});
		await expect(provider.refreshModels?.(publishContext() as never)).rejects.toThrow();
		expect(provider.getModels().map((model) => model.id)).toEqual(["saved-only"]);
	});

	it("applies live models for models.json providers without extension config", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ data: [{ id: "live-new" }] })),
		);
		const config = await configWithModelsJson({
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			models: [SAVED_MODEL],
		});
		const provider = composeModelProvider("models-gateway", undefined, config, undefined);
		expect(typeof provider.refreshModels).toBe("function");
		expect(provider.getModels().map((model) => model.id)).toEqual(["saved-only"]);

		await provider.refreshModels?.(publishContext() as never);
		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("live-new");
		expect(ids).not.toContain("saved-only");
	});

	it("prefers an explicitly provided refresh over the endpoint default", async () => {
		const custom = vi.fn(async () => [{ id: "custom-live", name: "Custom Live" }]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ data: [{ id: "endpoint-live" }] })),
		);
		const config = await emptyConfig();
		const provider = composeModelProvider("live-gateway", undefined, config, {
			baseUrl: "https://api.example.com/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [SAVED_MODEL],
			refreshModels: custom as never,
		});
		await provider.refreshModels?.(publishContext() as never);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(provider.getModels().map((model) => model.id)).toContain("custom-live");
	});
});
