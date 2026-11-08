import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/html/index.ts";

describe("HTML session export", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("refuses to overwrite the source session file", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "gama-export-"));
		const sessionPath = join(tempDir, "session.gama");
		const header = {
			type: "session",
			version: 3,
			id: "export-test",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const original = `${JSON.stringify(header)}\n`;
		writeFileSync(sessionPath, original);

		await expect(exportFromFile(sessionPath, sessionPath)).rejects.toThrow(
			"Refusing to overwrite the session file",
		);
		expect(readFileSync(sessionPath, "utf8")).toBe(original);
	});
});
