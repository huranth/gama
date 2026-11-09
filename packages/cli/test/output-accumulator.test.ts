import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { pruneTempFiles } from "../src/utils/temp-cleanup.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("pruneTempFiles", () => {
	let dir: string;
	let stale: string;
	let fresh: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gama-prune-"));
		stale = join(dir, "gama-test-old.log");
		fresh = join(dir, "gama-test-new.log");
		writeFileSync(stale, "old");
		writeFileSync(fresh, "new");
		const old = new Date(Date.now() - 8 * DAY_MS);
		utimesSync(stale, old, old);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("deletes only stale files with the prefix and suffix", () => {
		const otherPrefix = join(dir, "other-old.log");
		const otherSuffix = join(dir, "gama-test-old.txt");
		writeFileSync(otherPrefix, "keep");
		writeFileSync(otherSuffix, "keep");
		utimesSync(otherPrefix, new Date(0), new Date(0));
		utimesSync(otherSuffix, new Date(0), new Date(0));

		pruneTempFiles({
			folder: dir,
			prefix: "gama-test-",
			maxAgeMs: 7 * DAY_MS,
			isTarget: (name) => name.endsWith(".log"),
		});

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(otherPrefix)).toBe(true);
		expect(existsSync(otherSuffix)).toBe(true);
	});

	it("refuses an empty prefix or a non-positive age", () => {
		pruneTempFiles({ folder: dir, prefix: "", maxAgeMs: 7 * DAY_MS });
		pruneTempFiles({ folder: dir, prefix: "gama-test-", maxAgeMs: 0 });

		expect(existsSync(stale)).toBe(true);
	});
});

describe("OutputAccumulator temp pruning", () => {
	it("removes old logs when it creates a new output file", async () => {
		const prefix = `gama-acc-${randomUUID()}`;
		const stale = join(tmpdir(), `${prefix}-old.log`);
		const fresh = join(tmpdir(), `${prefix}-new.log`);
		writeFileSync(stale, "old");
		writeFileSync(fresh, "new");
		const old = new Date(Date.now() - 8 * DAY_MS);
		utimesSync(stale, old, old);

		const accumulator = new OutputAccumulator({
			maxBytes: 8,
			maxLines: 1,
			tempFilePrefix: prefix,
		});

		try {
			accumulator.append(Buffer.from("x".repeat(32)));
			accumulator.finish();
			const snapshot = accumulator.snapshot();
			await accumulator.closeTempFile();

			expect(existsSync(stale)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
			if (snapshot.fullOutputPath) rmSync(snapshot.fullOutputPath, { force: true });
		} finally {
			rmSync(fresh, { force: true });
			rmSync(stale, { force: true });
		}
	});
});
