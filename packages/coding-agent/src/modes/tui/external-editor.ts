import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess } from "../../utils/child-process.ts";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

export function parseEditorCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let hasToken = false;
	let quote: string | undefined;

	for (const char of command) {
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) {
				tokens.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
	}

	if (hasToken) {
		tokens.push(current);
	}

	return tokens;
}

export async function editInExternalEditor(
	options: ExternalEditorOptions,
): Promise<ExternalEditorResult> {
	const [editor, ...editorArgs] = parseEditorCommand(options.command);
	if (!editor) {
		return { status: "failed" };
	}

	const directory = mkdtempSync(join(tmpdir(), "gama-editor-"));
	const filePath = join(directory, "prompt.md");

	try {
		writeFileSync(filePath, options.content, "utf-8");
		process.stdout.write(
			`Launching external editor: ${options.command}\nGama will resume when the editor exits.\n`,
		);

		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawnProcess(editor, [...editorArgs, filePath], { stdio: "inherit" });
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return {
			status: "complete",
			content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, ""),
		};
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {}
	}
}
