import type { ModelCost } from "@huranth/gama-ai";
import type { Usage } from "@huranth/gama-ai/compat";
import { describe, expect, it } from "vitest";
import { assessCacheHealth } from "../src/core/cache/guard.ts";

const PRICED: Pick<ModelCost, "input" | "cacheRead" | "cacheWrite"> = {
	input: 3,
	cacheRead: 0.3,
	cacheWrite: 3.75,
};

const UNPRICED: Pick<ModelCost, "input" | "cacheRead" | "cacheWrite"> = {
	input: 3,
	cacheRead: 3,
	cacheWrite: 3,
};

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

function coldTurns(count: number, prompt = 5000): Usage[] {
	return Array.from({ length: count }, () => usage({ input: prompt }));
}

describe("assessCacheHealth", () => {
	it("stays quiet when cache retention is off", () => {
		const health = assessCacheHealth({
			usages: coldTurns(4),
			cost: PRICED,
			retention: "none",
		});

		expect(health.status).toBe("no-cache");
		expect(health.requests).toBe(4);
	});

	it("stays quiet when the model has no cache pricing", () => {
		expect(assessCacheHealth({ usages: coldTurns(4), cost: UNPRICED }).status).toBe("no-cache");
	});

	it("waits for enough requests before judging", () => {
		expect(assessCacheHealth({ usages: coldTurns(2), cost: PRICED }).status).toBe("ok");
	});

	it("ignores prompts below the cacheable minimum", () => {
		const health = assessCacheHealth({ usages: coldTurns(5, 500), cost: PRICED });

		expect(health.status).toBe("ok");
	});

	it("accepts any cache read as proof caching works", () => {
		const usages = [...coldTurns(3), usage({ input: 100, cacheRead: 4900 })];
		expect(assessCacheHealth({ usages, cost: PRICED }).status).toBe("ok");
	});

	it("flags a run of significant requests that never read the cache", () => {
		const health = assessCacheHealth({ usages: coldTurns(3, 8000), cost: PRICED });

		expect(health.status).toBe("cold");
		expect(health.requests).toBe(3);
		expect(health.message).toBe("No cache hits");
		expect(health.message).toBe("No cache hits");
	});

	it("does not count usages without a prompt", () => {
		const usages = [usage(), usage(), ...coldTurns(3, 8000)];
		const health = assessCacheHealth({ usages, cost: PRICED });

		expect(health.requests).toBe(3);
		expect(health.status).toBe("cold");
	});
});
