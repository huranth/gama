import type { ReadStream } from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captured streams
const opened: ReadStream[] = [];

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();

	return {
		...actual,
		createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
			const stream = actual.createReadStream(...args);
			opened.push(stream);

			return stream;
		},
	};
});

const { createReadToolDefinition } = await import("../src/core/tools/read.ts");

// Buffered read
const LINE_COUNT = 30_000;

// Abort checks
const ABORT_AT = 3;

function abortAfterChecks(limit: number): AbortSignal {
	let checks = 0;

	return {
		get aborted() {
			checks += 1;
			return checks >= limit;
		},
	} as unknown as AbortSignal;
}

describe("read tool streaming", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `gama-read-stream-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		opened.length = 0;
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	function writeLargeFile(name: string): string {
		const file = join(testDir, name);
		const line = `${"x".repeat(200)}\n`;

		writeFileSync(file, line.repeat(LINE_COUNT));

		return file;
	}

	it("destroys the file stream after a streamed read", async () => {
		const tool = createReadToolDefinition(testDir);

		await tool.execute(
			"read-stream",
			{ path: writeLargeFile("full.txt") },
			undefined,
			undefined,
			{} as never,
		);

		expect(opened).toHaveLength(1);
		expect(opened[0]?.destroyed).toBe(true);
	});

	it("stops scanning once the byte limit is reached", async () => {
		const tool = createReadToolDefinition(testDir);

		const result = await tool.execute(
			"read-stream-bytes",
			{ path: writeLargeFile("bytes.txt") },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		// Scanned lines
		expect(text).toContain("of 255");
		expect(text).not.toContain(`of ${LINE_COUNT}`);
	});

	it("stops scanning after the requested limit", async () => {
		const tool = createReadToolDefinition(testDir);

		const result = await tool.execute(
			"read-stream-limit",
			{ path: writeLargeFile("limit.txt"), limit: 5 },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text.split("\n")).toHaveLength(5);
		expect(text).not.toContain("more lines in file");
	});

	it("stops scanning at the line cap", async () => {
		const tool = createReadToolDefinition(testDir);
		const file = join(testDir, "lines.txt");
		const line = "abcdefghijklmnopqrs\n";

		// Buffered read
		writeFileSync(file, line.repeat(210_000));

		const result = await tool.execute(
			"read-stream-lines",
			{ path: file },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		// Scanned lines
		expect(text).toContain("of 2001");
		expect(text).not.toContain("of 210000");
	});

	it("destroys the file stream when the read aborts", async () => {
		const tool = createReadToolDefinition(testDir);
		const signal = abortAfterChecks(ABORT_AT);

		await expect(
			tool.execute(
				"read-abort",
				{ path: writeLargeFile("abort.txt") },
				signal,
				undefined,
				{} as never,
			),
		).rejects.toThrow("Operation aborted");

		expect(opened).toHaveLength(1);
		expect(opened[0]?.destroyed).toBe(true);
	});
});
