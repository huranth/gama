import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalGamaExperimental = process.env.GAMA_EXPERIMENTAL;

	afterEach(() => {
		if (originalGamaExperimental === undefined) {
			delete process.env.GAMA_EXPERIMENTAL;
		} else {
			process.env.GAMA_EXPERIMENTAL = originalGamaExperimental;
		}
	});

	it("returns false when GAMA_EXPERIMENTAL is unset", () => {
		delete process.env.GAMA_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when GAMA_EXPERIMENTAL is empty", () => {
		process.env.GAMA_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when GAMA_EXPERIMENTAL is set to 1", () => {
		process.env.GAMA_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when GAMA_EXPERIMENTAL is set to 0", () => {
		process.env.GAMA_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when GAMA_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.GAMA_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
