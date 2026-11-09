import { describe, expect, it } from "vitest";
import { exitCodeLabel } from "../src/core/exit-code.ts";

describe("exit code labels", () => {
	it("labels common failures without printing the number", () => {
		expect(exitCodeLabel(1)).toBe("failed");
		expect(exitCodeLabel(2)).toBe("usage error");
		expect(exitCodeLabel(128)).toBe("fatal error");
		expect(exitCodeLabel(137)).toBe("killed");
		expect(exitCodeLabel(143)).toBe("terminated");
		expect(exitCodeLabel(127)).toBe("command not found");
	});

	it("falls back to a plain failure for unknown codes", () => {
		expect(exitCodeLabel(7)).toBe("failed");
		expect(exitCodeLabel(42)).toBe("failed");
	});
});
