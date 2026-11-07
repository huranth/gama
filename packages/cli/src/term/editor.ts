import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess } from "../utils/child-process.ts";
import { stripBom } from "../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type ExternalEditorResult =
	| { status: "complete"; content: string }
	| { status: "failed"; reason?: "timeout" | "aborted" };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const FILE_MODE = 0o600;

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
		writeFileSync(filePath, options.content, { encoding: "utf-8", mode: FILE_MODE });
		process.stdout.write(
			`Launching external editor: ${options.command}\nGama will resume when the editor exits.\n`,
		);

		const child = spawnProcess(editor, [...editorArgs, filePath], { stdio: "inherit" });
		const exit = await waitForEditor(
			child,
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			options.signal,
		);

		if (exit.status === "timeout") {
			return { status: "failed", reason: "timeout" };
		}
		if (exit.status === "aborted") {
			return { status: "failed", reason: "aborted" };
		}
		if (exit.code !== 0) {
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

type EditorExit =
	| { status: "exited"; code: number | null }
	| { status: "timeout" }
	| { status: "aborted" };

function waitForEditor(
	child: ChildProcess,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<EditorExit> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (exit: EditorExit) => {
			if (settled) return;

			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(exit);
		};

		const stop = (exit: EditorExit) => {
			if (settled) return;

			child.kill();
			finish(exit);
		};

		const onAbort = () => {
			stop({ status: "aborted" });
		};

		timer = setTimeout(() => stop({ status: "timeout" }), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });

		child.once("error", () => finish({ status: "exited", code: null }));
		child.once("close", (code) => finish({ status: "exited", code }));

		if (signal?.aborted) onAbort();
	});
}
