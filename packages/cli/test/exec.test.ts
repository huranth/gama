import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	it("returns the exit code of a normal exit", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(3)"], process.cwd());
		expect(result.code).toBe(3);
	});
});
