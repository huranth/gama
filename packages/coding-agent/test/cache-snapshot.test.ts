import type { Api, Model } from "@huranth/gama-ai";
import type { Usage } from "@huranth/gama-ai/compat";
import { describe, expect, it } from "vitest";
import { buildCacheSnapshot, cacheRatesOf, cacheWindowOf } from "../src/core/cache/session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function usage(partial: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...partial,
	};
}

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "m1",
		name: "M1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.test",
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 8_000,
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		...overrides,
	} as Model<Api>;
}

function entry(overrides: {
	id?: string;
	timestamp?: number;
	role?: "assistant" | "user" | "toolResult";
	message?: Record<string, unknown>;
}): SessionEntry {
	return {
		type: "message",
		id: overrides.id ?? "e1",
		parentId: null,
		timestamp: "2026-10-20T00:00:00.000Z",
		message: {
			role: overrides.role ?? "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m1",
			usage: usage(),
			stopReason: "stop",
			timestamp: overrides.timestamp ?? 0,
			...(overrides.message ?? {}),
		},
	} as unknown as SessionEntry;
}

describe("buildCacheSnapshot", () => {
	it("skips non-assistant entries", () => {
		const snapshot = buildCacheSnapshot({
			entries: [
				entry({ role: "user" }),
				entry({ role: "toolResult" }),
				{
					type: "usage",
					id: "u1",
					parentId: null,
					timestamp: "",
					kind: "test",
					provider: "a",
					model: "m",
					usage: usage(),
				},
				entry({ message: { model: "m2", usage: usage({ input: 10, cacheRead: 90 }) } }),
			],
			resolveModel: () => model(),
		});

		expect(snapshot.rates).toHaveLength(1);
		expect(snapshot.latest).toBeCloseTo(0.9, 6);
	});

	it("resolves the model per message and prefers the response model", () => {
		const seen: string[] = [];
		buildCacheSnapshot({
			entries: [
				entry({ message: { model: "requested", responseModel: "served" } }),
				entry({ message: { provider: "openai", model: "gpt" } }),
			],
			resolveModel: (provider, id) => {
				seen.push(`${provider}/${id}`);
				return model();
			},
		});

		expect(seen[0]).toBe("anthropic/served");
		expect(seen[1]).toBe("openai/gpt");
	});

	it("reads the cache window from the model", () => {
		const snapshot = buildCacheSnapshot({
			entries: [entry({ timestamp: 1_000 })],
			resolveModel: () => model({ promptCache: { short: 300 } }),
			now: 61_000,
		});

		expect(snapshot.windowMs).toBe(300_000);
		expect(snapshot.leftMs).toBe(240_000);
		expect(snapshot.model).toBe("anthropic/m1");
	});

	it("clamps the time left at zero once the window closed", () => {
		const snapshot = buildCacheSnapshot({
			entries: [entry({ timestamp: 0 })],
			resolveModel: () => model({ promptCache: { short: 60 } }),
			now: 10_000_000,
		});

		expect(snapshot.leftMs).toBe(0);
	});

	it("leaves the forecast undefined when the model has no prices", () => {
		const snapshot = buildCacheSnapshot({
			entries: [entry({ message: { usage: usage({ input: 100, cacheRead: 900 }) } })],
			resolveModel: () => model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		});

		expect(snapshot.nextWarm).toBeUndefined();
		expect(snapshot.nextCold).toBeUndefined();
		expect(snapshot.totals.saved).toBe(0);
	});

	it("forecasts the next request when prices exist", () => {
		const snapshot = buildCacheSnapshot({
			entries: [
				entry({ message: { usage: usage({ input: 100, cacheRead: 900, output: 100 }) } }),
			],
			resolveModel: () => model(),
		});

		expect(snapshot.nextWarm).toBeCloseTo((1000 * 0.2 + 100 * 10) / 1_000_000, 9);
		expect(snapshot.nextCold).toBeCloseTo((1000 * 2.5 + 100 * 10) / 1_000_000, 9);
	});

	it("returns zeros for an empty session", () => {
		const snapshot = buildCacheSnapshot({ entries: [], resolveModel: () => model() });

		expect(snapshot.rates).toEqual([]);
		expect(snapshot.latest).toBe(0);
		expect(snapshot.model).toBeUndefined();
		expect(snapshot.windowMs).toBeUndefined();
	});

	it("reads rates from the input price alone", () => {
		expect(
			cacheRatesOf(model({ cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 2.5 } })),
		).toEqual({ input: 2, cacheRead: 0, cacheWrite: 2.5 });
		expect(
			cacheRatesOf(model({ cost: { input: 0, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } })),
		).toBeUndefined();
		expect(cacheWindowOf(model())).toBeUndefined();
	});
});
