import { describe, expect, it } from "vitest";
import { commandExitStatus, exitCodeLabel } from "../src/core/exit-code.ts";

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

	it("renders one short status line for any failure", () => {
		expect(commandExitStatus(1)).toBe("Command failed with exit 1");
		expect(commandExitStatus(2)).toBe("Command failed with exit 2");
		expect(commandExitStatus(128)).toBe("Command failed with exit 128");
		expect(commandExitStatus(137)).toBe("Command failed with exit 137");
		expect(commandExitStatus(42)).toBe("Command failed with exit 42");
	});
});
