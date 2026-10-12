import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deriveProviderId,
	fetchEndpointModels,
	normalizeBaseUrl,
	parseModelsPayload,
	resolveModels,
	saveCustomProviderModels,
	uniqueProviderId,
} from "../src/core/custom-provider.ts";

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const cleanupDirs: string[] = [];

afterEach(() => {
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("custom provider connection", () => {
	it("normalizes base URLs", () => {
		expect(normalizeBaseUrl(" tokenharbor.ai/v1 ")).toBe("https://tokenharbor.ai/v1");
		expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
		expect(normalizeBaseUrl("https://api.example.com/v1/models")).toBe(
			"https://api.example.com/v1",
		);
		expect(normalizeBaseUrl('"http://localhost:8080"')).toBe("http://localhost:8080");
		expect(normalizeBaseUrl("")).toBe("");
	});

	it("derives a short provider id from the host", () => {
		expect(deriveProviderId("https://tokenharbor.ai/v1")).toBe("tokenharbor");
		expect(deriveProviderId("https://api.together.xyz/v1")).toBe("together");
		expect(deriveProviderId("http://localhost:8080/v1")).toBe("localhost");
		expect(deriveProviderId("https://x.dev")).toBe("x");
	});

	it("de-duplicates provider ids", () => {
		expect(uniqueProviderId("tokenharbor", [])).toBe("tokenharbor");
		expect(uniqueProviderId("tokenharbor", ["tokenharbor"])).toBe("tokenharbor-2");
		expect(uniqueProviderId("tokenharbor", ["tokenharbor", "tokenharbor-2"])).toBe(
			"tokenharbor-3",
		);
	});

	it("parses OpenAI-, gateway- and Ollama-shaped payloads", () => {
		expect(parseModelsPayload({ data: [{ id: "gpt-x" }] }).map((m) => m.id)).toEqual(["gpt-x"]);
		expect(parseModelsPayload({ models: [{ name: "llama3:8b" }] }).map((m) => m.id)).toEqual([
			"llama3:8b",
		]);
		expect(parseModelsPayload(["a", "b"]).map((m) => m.id)).toEqual(["a", "b"]);
		expect(
			parseModelsPayload({ data: [{ id: "a" }, { id: "a" }, { id: "b" }] }).map((m) => m.id),
		).toEqual(["a", "b"]);
		expect(parseModelsPayload({ data: {} })).toEqual([]);
	});

	it("reads endpoint metadata when present", () => {
		const [model] = parseModelsPayload({
			data: [
				{
					id: "deepseek-v4",
					name: "DeepSeek V4",
					context_length: 200000,
					max_output_tokens: 8192,
					reasoning: true,
					input_modalities: ["text", "image"],
				},
			],
		});
		expect(model).toMatchObject({
			id: "deepseek-v4",
			name: "DeepSeek V4",
			contextWindow: 200000,
			maxTokens: 8192,
			reasoning: true,
			input: ["text", "image"],
		});
	});

	it("resolves metadata layer by layer", () => {
		const builtin = [{ id: "known", contextWindow: 100000, maxTokens: 4096, reasoning: true }];
		const modelsDev = {
			openai: { models: { "dev-only": { limit: { context: 64000, output: 2048 } } } },
		};

		const resolved = resolveModels(
			[
				{ id: "from-endpoint", name: "From Endpoint", contextWindow: 32000, input: ["text"] },
				{ id: "known", name: "Known", input: ["text"] },
				{ id: "dev-only", name: "Dev Only", input: ["text"] },
				{ id: "unknown-model", name: "Unknown", input: ["text"] },
			],
			builtin as never,
			modelsDev,
		);

		expect(resolved[0]).toMatchObject({ contextWindow: 32000, maxTokens: 16384 });
		expect(resolved[1]).toMatchObject({
			contextWindow: 100000,
			maxTokens: 4096,
			reasoning: true,
		});
		expect(resolved[2]).toMatchObject({ contextWindow: 64000, maxTokens: 2048 });
		expect(resolved[3]).toMatchObject({
			contextWindow: 128000,
			maxTokens: 16384,
			reasoning: false,
		});
	});

	it("fetches models and falls back to /v1/models for a bare origin", async () => {
		const seen: string[] = [];
		const fetchImpl = vi.fn(async (url: string) => {
			seen.push(url);
			return url.endsWith("/v1/models")
				? jsonResponse({ data: [{ id: "m1" }] })
				: new Response("nope", { status: 404 });
		}) as unknown as typeof fetch;

		const models = await fetchEndpointModels("https://example.com", "k", { fetchImpl });
		expect(models.map((m) => m.id)).toEqual(["m1"]);
		expect(seen).toEqual(["https://example.com/models", "https://example.com/v1/models"]);
	});

	it("reports the endpoint's HTTP status on failure", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("forbidden", { status: 403 }),
		) as unknown as typeof fetch;
		await expect(
			fetchEndpointModels("https://example.com/v1", "k", { fetchImpl }),
		).rejects.toThrow(/403/);
	});

	it("merges a provider into models.json without dropping " + "existing providers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gama-custom-provider-"));
		cleanupDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { existing: { baseUrl: "https://existing/v1" } } }),
		);

		await saveCustomProviderModels(modelsPath, "tokenharbor", {
			name: "tokenharbor",
			baseUrl: "https://tokenharbor.ai/v1",
			api: "openai-completions",
			models: [{ id: "m1" }],
		});

		const written = JSON.parse(readFileSync(modelsPath, "utf-8"));
		expect(Object.keys(written.providers).sort()).toEqual(["existing", "tokenharbor"]);
		expect(written.providers.tokenharbor.models).toEqual([{ id: "m1" }]);
	});
});
