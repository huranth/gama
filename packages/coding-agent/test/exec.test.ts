import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("execCommand", () => {
	it("returns the exit code of a normal exit", async () => {
		const result = await execCommand(process.execPath, ["-e", "process.exit(3)"], process.cwd());
		expect(result.code).toBe(3);
	});

	it.skipIf(process.platform === "win32")(
		"reports a child killed by a signal as failure, not exit 0",
		async () => {
			const result = await execCommand(
				process.execPath,
				["-e", "process.kill(process.pid, 'SIGKILL')"],
				process.cwd(),
			);
			expect(result.code).toBe(128 + 9);
			expect(result.killed).toBe(false);
		},
	);
});
