import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

describe("read binary guard", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	test("rejects binary bytes instead of returning them as text", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "gama-read-binary-"));
		writeFileSync(
			join(tempDir, "archive.tar.gz"),
			Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x07, 0x00, 0xff, 0xfe]),
		);

		const tool = createReadToolDefinition(tempDir);
		const result = await tool.execute(
			"read-binary",
			{ path: "archive.tar.gz" },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("binary");
		expect(text).not.toContain("\x00");
	});
});
