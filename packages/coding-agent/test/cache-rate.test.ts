import type { Usage } from "@huranth/gama-ai/compat";
import { describe, expect, it } from "vitest";
import {
	billedCost,
	type CacheRates,
	cacheTotals,
	hitRate,
	projectCost,
	promptTokens,
	savedCost,
	uncachedCost,
} from "../src/core/cache/rate.ts";

const RATES: CacheRates = {
	input: 2,
	cacheRead: 0.2,
	cacheWrite: 2.5,
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

describe("hitRate", () => {
	it("returns zero for an empty prompt", () => {
		expect(hitRate(usage())).toBe(0);
	});

	it("returns zero for a pure cold write", () => {
		expect(hitRate(usage({ cacheWrite: 1000 }))).toBe(0);
	});

	it("measures cache reads against the whole prompt", () => {
		expect(hitRate(usage({ input: 30, cacheRead: 970 }))).toBeCloseTo(0.97, 6);
	});

	it("counts input, reads, and writes in the prompt", () => {
		expect(promptTokens(usage({ input: 10, cacheRead: 20, cacheWrite: 30 }))).toBe(60);
	});
});

describe("cost", () => {
	it("prices every prompt bucket at its own rate", () => {
		const turn = usage({ input: 100, cacheRead: 900 });
		expect(billedCost(turn, RATES)).toBeCloseTo((100 * 2 + 900 * 0.2) / 1_000_000, 9);
	});

	it("prices a cold prompt at the input rate", () => {
		const turn = usage({ input: 100, cacheRead: 900 });
		expect(uncachedCost(turn, RATES)).toBeCloseTo((1000 * 2) / 1_000_000, 9);
	});

	it("reports the difference as savings", () => {
		const turn = usage({ input: 100, cacheRead: 900 });
		expect(savedCost(turn, RATES)).toBeCloseTo((2000 - 380) / 1_000_000, 9);
	});

	it("clamps savings at zero when writing costs more than a cold prompt", () => {
		expect(savedCost(usage({ cacheWrite: 1000 }), RATES)).toBe(0);
	});

	it("falls back to reported costs without rates", () => {
		const turn = usage({
			input: 100,
			cacheRead: 900,
			cost: { input: 1, output: 0, cacheRead: 2, cacheWrite: 0, total: 3 },
		});
		expect(billedCost(turn)).toBeCloseTo(3, 6);
		expect(savedCost(turn)).toBe(0);
	});

	it("forecasts the next request with the warm or cold rate", () => {
		const base = { rates: RATES, prompt: 1000, output: 100, outputRate: 10, added: 250 };
		expect(projectCost({ ...base, warm: true })).toBeCloseTo(
			(1000 * 0.2 + 250 * 2 + 1000) / 1_000_000,
			9,
		);
		expect(projectCost({ ...base, warm: false })).toBeCloseTo((1250 * 2.5 + 1000) / 1_000_000, 9);
	});
});

describe("cacheTotals", () => {
	it("sums buckets across turns that price differently", () => {
		const totals = cacheTotals([
			{ usage: usage({ input: 1000, output: 10 }), rates: RATES },
			{
				usage: usage({ cacheRead: 900, cacheWrite: 100, output: 5 }),
				rates: { input: 4, cacheRead: 0.4, cacheWrite: 5 },
			},
		]);

		expect(totals.input).toBe(1000);
		expect(totals.cacheRead).toBe(900);
		expect(totals.cacheWrite).toBe(100);
		expect(totals.output).toBe(15);
		expect(totals.prompt).toBe(2000);
		expect(totals.hit).toBeCloseTo(0.45, 6);
		expect(totals.uncached).toBeCloseTo((2000 + 4000) / 1_000_000, 9);
		expect(totals.spent).toBeCloseTo((2000 + 360 + 500) / 1_000_000, 9);
		expect(totals.saved).toBeCloseTo(totals.uncached - totals.spent, 6);
	});

	it("returns zeros with no turns", () => {
		const totals = cacheTotals([]);
		expect(totals.hit).toBe(0);
		expect(totals.saved).toBe(0);
		expect(totals.prompt).toBe(0);
	});
});
