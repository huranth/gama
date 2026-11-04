import { describe, expect, it } from "vitest";
import {
	applyModelsDevMetadata,
	fetchModelsDevCatalog,
	findModelsDevModel,
	type ModelsDevCatalog,
} from "../src/registry-dev.ts";

const catalog: ModelsDevCatalog = {
	"zai-org": {
		id: "zai-org",
		name: "Z.AI",
		models: {
			"glm-5.3-flash": {
				name: "GLM 5.3 Flash",
				reasoning: true,
				limit: { context: 200_000, output: 32_000 },
				cost: { input: 0.5, output: 1.5, cache_read: 0.1 },
				modalities: { input: ["text", "image"] },
			},
		},
	},
	anthropic: {
		id: "anthropic",
		name: "Anthropic",
		models: {
			"claude-sonnet-4-6": {
				limit: { context: 1_000_000, output: 64_000 },
				cost: { input: 3, output: 15 },
			},
		},
	},
};

function cancelableBody(): { body: ReadableStream<Uint8Array>; wasCanceled: () => boolean } {
	let canceled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]));
		},
		cancel() {
			canceled = true;
		},
	});

	return { body, wasCanceled: () => canceled };
}

describe("findModelsDevModel", () => {
	it("matches an exact provider and model id", () => {
		const entry = findModelsDevModel(catalog, "zai-org", "glm-5.3-flash");
		expect(entry?.name).toBe("GLM 5.3 Flash");
	});

	it("normalizes provider casing and vendor-prefixed model ids", () => {
		const entry = findModelsDevModel(catalog, "ZAI-ORG", "zai-org/GLM-5.3-Flash");
		expect(entry?.limit?.context).toBe(200_000);
	});

	it("falls back to a model id match on another provider", () => {
		const entry = findModelsDevModel(catalog, "openrouter", "anthropic/claude-sonnet-4.6");
		expect(entry?.limit?.context).toBe(1_000_000);
	});

	it("returns undefined for unknown models and empty catalogs", () => {
		expect(findModelsDevModel(catalog, "zai-org", "unknown-model")).toBeUndefined();
		expect(findModelsDevModel(undefined, "zai-org", "glm-5.3-flash")).toBeUndefined();
	});
});

describe("applyModelsDevMetadata", () => {
	it("fills missing context, output, reasoning, cost and image modality", () => {
		const model: {
			id: string;
			provider: string;
			contextWindow: number;
			maxTokens?: number;
			reasoning?: boolean;
			input: string[];
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		} = {
			id: "glm-5.3-flash",
			provider: "zai-org",
			contextWindow: 0,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};

		const enriched = applyModelsDevMetadata(model, catalog);

		expect(enriched.contextWindow).toBe(200_000);
		expect(enriched.maxTokens).toBe(32_000);
		expect(enriched.reasoning).toBe(true);
		expect(enriched.input).toEqual(["text", "image"]);
		expect(enriched.cost).toEqual({ input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.5 });
	});

	it("keeps explicit values instead of overwriting them", () => {
		const model = {
			id: "glm-5.3-flash",
			provider: "zai-org",
			contextWindow: 128_000,
			maxTokens: 8_192,
			reasoning: false,
			input: ["text"],
			cost: { input: 9, output: 12, cacheRead: 1, cacheWrite: 2 },
		};

		const enriched = applyModelsDevMetadata(model, catalog);

		expect(enriched.contextWindow).toBe(128_000);
		expect(enriched.maxTokens).toBe(8_192);
		expect(enriched.reasoning).toBe(false);
		expect(enriched.cost).toEqual({ input: 9, output: 12, cacheRead: 1, cacheWrite: 2 });
	});

	it("returns the model untouched when the catalog has no match", () => {
		const model = { id: "unknown", provider: "unknown", contextWindow: 1 };
		expect(applyModelsDevMetadata(model, catalog)).toEqual(model);
		expect(applyModelsDevMetadata(model, undefined)).toBe(model);
	});
});

describe("fetchModelsDevCatalog", () => {
	it("parses a catalog response", async () => {
		const fetched = await fetchModelsDevCatalog({
			fetchImpl: async () =>
				new Response(JSON.stringify({ openai: { models: { "gpt-5": { name: "GPT-5" } } } })),
		});

		expect(fetched?.openai?.models?.["gpt-5"]?.name).toBe("GPT-5");
	});

	it("ignores prototype provider names", async () => {
		const fetched = await fetchModelsDevCatalog({
			fetchImpl: async () =>
				new Response(
					'{"__proto__":{"id":"bad"},"constructor":{"id":"bad"},"safe":{"id":"safe"}}',
				),
		});

		expect(fetched?.safe?.id).toBe("safe");
		expect(Object.hasOwn(fetched ?? {}, "__proto__")).toBe(false);
		expect(Object.hasOwn(fetched ?? {}, "constructor")).toBe(false);
	});

	it("returns undefined for a non-ok response", async () => {
		const fetched = await fetchModelsDevCatalog({
			fetchImpl: async () => new Response("nope", { status: 500 }),
		});

		expect(fetched).toBeUndefined();
	});

	it("cancels the body of a non-ok response", async () => {
		const { body, wasCanceled } = cancelableBody();
		const fetched = await fetchModelsDevCatalog({
			fetchImpl: async () => new Response(body, { status: 500 }),
		});

		expect(fetched).toBeUndefined();
		expect(wasCanceled()).toBe(true);
	});

	it("cancels the body when content-length is over the limit", async () => {
		const { body, wasCanceled } = cancelableBody();
		const headers = { "content-length": String(26 * 1024 * 1024) };
		const fetched = await fetchModelsDevCatalog({
			fetchImpl: async () => new Response(body, { status: 200, headers }),
		});

		expect(fetched).toBeUndefined();
		expect(wasCanceled()).toBe(true);
	});

	it("returns undefined when the fetch throws", async () => {
		const fetched = await fetchModelsDevCatalog({
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});

		expect(fetched).toBeUndefined();
	});

	it("aborts and returns undefined when the timeout elapses", async () => {
		const fetched = await fetchModelsDevCatalog({
			timeoutMs: 5,
			fetchImpl: (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
		});

		expect(fetched).toBeUndefined();
	});
});
