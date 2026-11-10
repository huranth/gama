import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/rpc/client.ts";

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

		await expect(client.getCommands()).rejects.toThrow(/Agent exited: code 43/);
	});

	test("rejects waitForIdle when the child exits before settling", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.resume();
setTimeout(() => process.exit(46), 200);
`),
		});

		await client.start();

		await expect(client.waitForIdle(5_000)).rejects.toThrow(/Agent exited: code 46/);
	});

	test("cleans up the event collector when prompt fails", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => process.exit(47));
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.promptAndWait("hello", undefined, 5_000)).rejects.toThrow(
			/Agent exited: code 47/,
		);

		const privateClient = client as unknown as { eventListeners: unknown[] };
		expect(privateClient.eventListeners).toHaveLength(0);
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
				/Request timeout: get_commands/,
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
