import { describe, expect, test } from "vitest";
import { formatCrashExtensionHint } from "../src/modes/tui/interactive-mode.ts";

describe("formatCrashExtensionHint", () => {
	test("identifies extensions with frames in a crash stack", () => {
		expect(formatCrashExtensionHint(["npm:gama-observational-memory"])).toBe(
			"A stack frame came from loaded extension `npm:gama-observational-memory`, " +
				"which may be involved. Try disabling it with `gama config`, or run " +
				"`gama -ne` to confirm.",
		);
		expect(formatCrashExtensionHint(undefined)).toBeUndefined();
	});

	test("pluralizes multiple extensions", () => {
		expect(formatCrashExtensionHint(["ext-a", "ext-b"])).toBe(
			"A stack frame came from loaded extensions `ext-a` and `ext-b`, which may " +
				"be involved. Try disabling them with `gama config`, or run `gama -ne` " +
				"to confirm.",
		);
	});
});
