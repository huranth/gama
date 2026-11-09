import { describe, expect, it } from "vitest";
import { modelsDevCacheHint } from "../src/core/cache/models-dev.ts";
import { type ModelsDevCatalog, resolveModels } from "../src/core/custom-provider.ts";

function catalog(): ModelsDevCatalog {
	return {
		anthropic: {
			npm: "@ai-sdk/anthropic",
			models: {
				"claude-sonnet-4-6": {
					family: "claude-sonnet",
					cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
					limit: { context: 200_000, output: 8192 },
					modalities: { input: ["text", "image"] },
				},
			},
		},
		gateway: {
			npm: "@ai-sdk/openai-compatible",
			models: {
				"mythos-9": {
					family: "claude-mythos",
					cost: { input: 2, output: 8 },
				},
				"deepseek-v4.1-flash": {
					family: "deepseek-flash",
					cost: { input: 0.3, output: 1.2 },
				},
			},
		},
	};
}

describe("modelsDevCacheHint", () => {
	it.each([
		"claude-sonnet-4-6",
		"claude-sonnet-4.6",
		"anthropic/claude-sonnet-4-6",
		"claude-sonnet-4-6-20260101",
	])("resolves %s to explicit Anthropic caching", (id) => {
		expect(modelsDevCacheHint(catalog(), id)).toEqual({
			cacheControlFormat: "anthropic",
			cachePriced: true,
		});
	});

	it("uses the models.dev family when the id does not name Claude", () => {
		expect(modelsDevCacheHint(catalog(), "mythos-9")).toEqual({
			cacheControlFormat: "anthropic",
			cachePriced: false,
		});
	});

	it("leaves automatic-cache families unmarked", () => {
		expect(modelsDevCacheHint(catalog(), "deepseek-v4.1-flash")).toEqual({
			cachePriced: false,
		});
	});

	it("returns no hint without a catalog or a match", () => {
		expect(modelsDevCacheHint(undefined, "claude-sonnet-4-6")).toEqual({ cachePriced: false });
		expect(modelsDevCacheHint(catalog(), "unknown-model")).toEqual({ cachePriced: false });
	});
});

describe("resolveModels cache hint", () => {
	it("carries the models.dev cache format and pricing", () => {
		const [resolved] = resolveModels(
			[{ id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", input: ["text"] }],
			[],
			catalog(),
		);

		expect(resolved?.cacheControlFormat).toBe("anthropic");
		expect(resolved?.cachePriced).toBe(true);
		expect(resolved?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
	});

	it("leaves models without a cache-capable match unmarked", () => {
		const [resolved] = resolveModels(
			[{ id: "deepseek-v4.1-flash", name: "DeepSeek", input: ["text"] }],
			[],
			catalog(),
		);

		expect(resolved?.cacheControlFormat).toBeUndefined();
		expect(resolved?.cachePriced).toBe(false);
	});
});
