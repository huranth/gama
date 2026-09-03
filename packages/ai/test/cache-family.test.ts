import { describe, expect, it } from "vitest";
import { modelFamilyTokens, normalizeModelId, requiresExplicitCache } from "../src/cache/family.ts";

describe("normalizeModelId", () => {
	it("drops vendor prefixes, tags, and separators", () => {
		expect(normalizeModelId("anthropic/claude-sonnet-4.6:free")).toBe("claude-sonnet-4-6");
		expect(normalizeModelId("x/y/z")).toBe("z");
		expect(normalizeModelId("  gpt-5  ")).toBe("gpt-5");
	});

	it("strips date and version tails", () => {
		expect(normalizeModelId("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet");
		expect(normalizeModelId("us.anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(
			"us-anthropic-claude-3-5-sonnet",
		);
		expect(normalizeModelId("claude-sonnet-4-6-latest")).toBe("claude-sonnet-4-6");
	});

	it("is case-insensitive", () => {
		expect(normalizeModelId("CLAUDE-Opus-9.9")).toBe("claude-opus-9-9");
	});
});

describe("modelFamilyTokens", () => {
	it("adds models.dev family vocabulary", () => {
		const tokens = modelFamilyTokens("mythos-9", "claude-mythos");
		expect(tokens).toContain("mythos");
		expect(tokens).toContain("claude-mythos");
		expect(tokens).toContain("claude");
	});
});

describe("requiresExplicitCache", () => {
	it.each([
		["claude-sonnet-4.6"],
		["anthropic/claude-sonnet-4.6"],
		["CLAUDE-OPUS-9-9"],
		["us.anthropic.claude-3-5-sonnet-20241022-v2:0"],
	])("recognizes %s", (id) => {
		expect(requiresExplicitCache({ id })).toBe(true);
	});

	it("recognizes Anthropic endpoints and providers", () => {
		expect(requiresExplicitCache({ id: "m1", provider: "anthropic" })).toBe(true);
		expect(requiresExplicitCache({ id: "m1", baseUrl: "https://api.anthropic.com/v1" })).toBe(
			true,
		);
	});

	it("uses the models.dev family when the id says nothing", () => {
		expect(requiresExplicitCache({ id: "mythos-9", family: "claude-mythos" })).toBe(true);
	});

	it.each([["deepseek-v4.1-flash"], ["gpt-5"], ["gemini-3-pro"], ["qwen3-coder-plus"]])(
		"leaves %s on automatic caching",
		(id) => {
			expect(requiresExplicitCache({ id })).toBe(false);
		},
	);
});
