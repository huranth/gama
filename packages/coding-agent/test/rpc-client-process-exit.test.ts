import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "gama-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(
			/Agent process exited \(code=43 signal=null\)/,
		);
	});

	test("times out quick commands but lets long-running commands wait", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.resume();
setInterval(() => {}, 1000);
`),
		});
		await client.start();

		vi.useFakeTimers();
		try {
			const quick = expect(client.getCommands()).rejects.toThrow(
				/Timeout waiting for response to get_commands/,
			);
			let bashSettled = false;
			const bash = client.bash("sleep 60");
			bash.then(
				() => {
					bashSettled = true;
				},
				() => {
					bashSettled = true;
				},
			);

			await vi.advanceTimersByTimeAsync(31_000);

			await quick;
			expect(bashSettled).toBe(false);
		} finally {
			vi.useRealTimers();
			await client.stop();
		}
	});
});
