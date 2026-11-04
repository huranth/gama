import { describe, expect, it } from "vitest";
import { createModels, type Provider } from "../src/registry.ts";

function brokenProvider(id: string): Provider {
	const failure = new Error(`getModels failed: ${id}`);

	return {
		id,
		name: id,
		auth: {},
		getModels: () => {
			throw failure;
		},
		stream: () => {
			throw failure;
		},
		streamSimple: () => {
			throw failure;
		},
	} as unknown as Provider;
}

function healthyProvider(id: string): Provider {
	return {
		id,
		name: id,
		auth: {},
		getModels: () => [
			{
				id: `${id}-model`,
				name: `${id} model`,
				api: "openai-completions",
				provider: id,
				baseUrl: "http://127.0.0.1:9",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	} as unknown as Provider;
}

describe("getModels errors", () => {
	it("reports the error and returns [] for a single provider", () => {
		const seen: [string, Error][] = [];
		const models = createModels({
			onModelError: (providerId, error) => {
				seen.push([providerId, error]);
			},
		});
		models.setProvider(brokenProvider("broken"));

		expect(models.getModels("broken")).toEqual([]);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.[0]).toBe("broken");
		expect(seen[0]?.[1].message).toContain("getModels failed");
	});

	it("reports the error and keeps the other providers when no provider is picked", () => {
		const seen: [string, Error][] = [];
		const models = createModels({
			onModelError: (providerId, error) => {
				seen.push([providerId, error]);
			},
		});
		models.setProvider(brokenProvider("broken"));
		models.setProvider(healthyProvider("healthy"));

		expect(models.getModels().map((model) => model.provider)).toEqual(["healthy"]);
		expect(seen.map(([providerId]) => providerId)).toEqual(["broken"]);
		expect(seen[0]?.[1].message).toContain("getModels failed: broken");
	});
});
