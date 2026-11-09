import { describe, expect, it } from "vitest";
import type { CacheSnapshot } from "../src/core/cache/session.ts";
import { cacheRows, formatMoney, formatPercent, hitTone } from "../src/core/cache/view.ts";

function snapshot(overrides: Partial<CacheSnapshot> = {}): CacheSnapshot {
	return {
		rates: [],
		latest: 0,
		totals: {
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			prompt: 0,
			hit: 0,
			spent: 0,
			uncached: 0,
			saved: 0,
		},
		windowMs: undefined,
		leftMs: 0,
		nextWarm: undefined,
		nextCold: undefined,
		model: undefined,
		warmTurns: 0,
		coldTurns: 0,
		warmRatio: 0,
		unreported: 0,
		lookbackPositions: undefined,
		warmSpent: 0,
		warmRequests: 0,
		...overrides,
	};
}

describe("hitTone", () => {
	it("maps rates to success, warning, and error", () => {
		expect(hitTone(0.97)).toBe("success");
		expect(hitTone(0.9)).toBe("success");
		expect(hitTone(0.5)).toBe("warning");
		expect(hitTone(0.49)).toBe("error");
	});
});

describe("formatMoney", () => {
	it("scales the precision to the amount", () => {
		expect(formatMoney(0)).toBe("$0.00");
		expect(formatMoney(0.0005)).toBe("<$0.001");
		expect(formatMoney(0.005)).toBe("$0.0050");
		expect(formatMoney(5)).toBe("$5.000");
		expect(formatMoney(50)).toBe("$50.00");
		expect(formatMoney(5000)).toBe("$5000");
	});

	it("falls back for non-finite input", () => {
		expect(formatMoney(Number.NaN)).toBe("$0.00");
	});
});

describe("formatPercent", () => {
	it("keeps one decimal", () => {
		expect(formatPercent(0.973)).toBe("97.3%");
		expect(formatPercent(0)).toBe("0.0%");
	});
});

describe("cacheRows", () => {
	it("lists the core cache figures", () => {
		const rows = cacheRows(
			snapshot({
				latest: 0.97,
				rates: [0.9, 0.97],
				totals: {
					input: 30,
					cacheRead: 970,
					cacheWrite: 0,
					output: 10,
					prompt: 1000,
					hit: 0.97,
					spent: 0.5,
					uncached: 2,
					saved: 1.5,
				},
			}),
		);
		const labels = rows.map(([label]) => label);

		expect(labels).toContain("hit rate");
		expect(labels).toContain("read");
		expect(labels).toContain("write");
		expect(labels).toContain("saved");
		expect(rows).toContainEqual(["hit rate", "97.0%"]);
		expect(rows).toContainEqual(["saved", "$1.500"]);
	});

	it("adds window, forecast, and model rows when known", () => {
		const rows = cacheRows(
			snapshot({
				windowMs: 300_000,
				leftMs: 65_000,
				nextWarm: 0.2,
				nextCold: 2,
				model: "anthropic/m1",
			}),
		);

		expect(rows).toContainEqual(["window", "5m"]);
		expect(rows).toContainEqual(["left", "1:05"]);
		expect(rows).toContainEqual(["next warm", "$0.200"]);
		expect(rows).toContainEqual(["next cold", "$2.000"]);
		expect(rows).toContainEqual(["model", "anthropic/m1"]);
	});

	it("omits the forecast when the model has no prices", () => {
		const labels = cacheRows(snapshot()).map(([label]) => label);

		expect(labels).not.toContain("next warm");
		expect(labels).not.toContain("window");
		expect(labels).toContain("requests");
	});
});
