import type { ThinkingLevel } from "@huranth/gama-agent-core";
import { describe, expect, test } from "vitest";
import { parseThinkingLevel } from "../src/cli/args.ts";
import { REASONING_LEVELS, reasoningLevelName, reasoningLevelTier } from "../src/core/defaults.ts";

describe("reasoning level ladder", () => {
	test("covers every canonical tier in escalation order", () => {
		expect(REASONING_LEVELS.map((level) => level.tier)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(REASONING_LEVELS.map((level) => level.name)).toEqual([
			"parked",
			"idling",
			"cruising",
			"steady",
			"pushing",
			"overdrive",
			"redline",
		]);
	});

	test("maps names to tiers case-insensitively and back", () => {
		expect(reasoningLevelTier("PUSHING")).toBe("high");
		expect(reasoningLevelTier(" steady ")).toBe("medium");
		expect(reasoningLevelTier("arcane-elite")).toBeUndefined();
		expect(reasoningLevelName("xhigh")).toBe("overdrive");
		expect(reasoningLevelName("mineral" as ThinkingLevel)).toBe("mineral");
	});

	test("parseThinkingLevel accepts canonical tiers and Gama names", () => {
		expect(parseThinkingLevel("medium")).toBe("medium");
		expect(parseThinkingLevel("redline")).toBe("max");
		expect(parseThinkingLevel("nope")).toBeUndefined();
	});
});
