import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type ExternalEditorResult,
	editInExternalEditor,
	parseEditorCommand,
} from "../src/modes/tui/external-editor.ts";

const editorFixturePath = fileURLToPath(
	new URL("./fixtures/fake-external-editor.mjs", import.meta.url),
);

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "gama-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		const result = await editInExternalEditor({
			command:
				`"${process.execPath}" "${editorFixturePath}" "${capturePath}"` +
				`${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^gama-editor-.+$/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor("--fail");

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor("--empty");

		expect(result).toEqual({ status: "complete", content: "" });
	});

	it("runs an editor whose path and arguments contain spaces", async () => {
		const spacedDirectory = mkdtempSync(join(tmpdir(), "gama editor with spaces-"));
		try {
			const capturePath = join(spacedDirectory, "capture file.json");
			const result = await editInExternalEditor({
				command: `"${process.execPath}" "${editorFixturePath}" "${capturePath}"`,
				content: "original",
			});
			const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;

			expect(result).toEqual({ status: "complete", content: "edited" });
			expect(capture.content).toBe("original");
		} finally {
			rmSync(spacedDirectory, { recursive: true, force: true });
		}
	});

	it("fails without launching when the command is empty", async () => {
		await expect(editInExternalEditor({ command: "   ", content: "original" })).resolves.toEqual({
			status: "failed",
		});
	});
});

describe("parseEditorCommand", () => {
	it("splits unquoted commands on whitespace", () => {
		expect(parseEditorCommand("code --wait  --new-window")).toEqual([
			"code",
			"--wait",
			"--new-window",
		]);
	});

	it("keeps quoted segments containing spaces together", () => {
		expect(
			parseEditorCommand(`"C:\\Program Files\\Editor\\editor.exe" --flag 'single quoted' ""`),
		).toEqual(["C:\\Program Files\\Editor\\editor.exe", "--flag", "single quoted", ""]);
	});

	it("returns no tokens for blank commands", () => {
		expect(parseEditorCommand("  ")).toEqual([]);
	});
});
