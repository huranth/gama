import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, runToolCall } from "@huranth/gama-agent-core";
import { beforeAll, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	createFileReadTracker,
	READ_BEFORE_CHANGE_MESSAGE,
} from "../src/core/tools/file-read-tracker.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { formatActivityLine } from "../src/term/parts/activity.ts";
import { initTheme } from "../src/term/theme/theme.ts";

type FailureCase = {
	name: string;
	tool: (cwd: string) => AgentTool<any>;
	args: Record<string, unknown>;
	message: string;
};

async function audit(cwd: string, failure: FailureCase) {
	const tool = failure.tool(cwd);
	const outcome = await runToolCall(
		{
			type: "toolCall",
			id: `call-${failure.name}`,
			name: tool.name,
			arguments: failure.args as any,
		},
		{
			tools: [tool],
			assistantMessage: { role: "assistant", content: [], timestamp: 0 } as any,
			context: { messages: [], tools: [tool] },
		},
	);
	const text = (outcome.result.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { outcome, text };
}

function cases(): FailureCase[] {
	const tracker = createFileReadTracker();
	return [
		{
			name: "read missing file",
			tool: createReadTool,
			args: { path: "missing.ts" },
			message: "File missing",
		},
		{
			name: "read directory",
			tool: createReadTool,
			args: { path: "." },
			message: "Not a file",
		},
		{
			name: "read past the end",
			tool: createReadTool,
			args: { path: "a.ts", offset: 99 },
			message: "Offset too big",
		},
		{
			name: "bash non zero exit",
			tool: createBashTool,
			args: { command: "exit 2", timeout: 10 },
			message: "Command failed",
		},
		{
			name: "bash bad timeout",
			tool: createBashTool,
			args: { command: "echo hi", timeout: 0 },
			message: "Bad timeout",
		},
		{
			name: "bash missing cwd",
			tool: (dir) => createBashTool(join(dir, "nope")),
			args: { command: "echo hi", timeout: 10 },
			message: "Cwd missing",
		},
		{
			name: "edit missing file",
			tool: createEditTool,
			args: { path: "missing.ts", edits: [{ oldText: "a", newText: "b" }] },
			message: "File missing",
		},
		{
			name: "edit without a match",
			tool: createEditTool,
			args: { path: "a.ts", edits: [{ oldText: "absent", newText: "b" }] },
			message: "Text missing",
		},
		{
			name: "edit duplicate match",
			tool: createEditTool,
			args: { path: "a.ts", edits: [{ oldText: "const value = 1;", newText: "x" }] },
			message: "Duplicate text",
		},
		{
			name: "edit no changes",
			tool: createEditTool,
			args: { path: "a.ts", edits: [] },
			message: "No edits",
		},
		{
			name: "edit unread file",
			tool: (dir) => createEditTool(dir, { tracker }),
			args: { path: "a.ts", edits: [{ oldText: "const value", newText: "x" }] },
			message: READ_BEFORE_CHANGE_MESSAGE,
		},
		{
			name: "write unread file",
			tool: (dir) => createWriteTool(dir, { tracker }),
			args: { path: "a.ts", content: "x" },
			message: READ_BEFORE_CHANGE_MESSAGE,
		},
		{
			name: "edit a directory",
			tool: createEditTool,
			args: { path: ".", edits: [{ oldText: "a", newText: "b" }] },
			message: "Not a file",
		},
		{
			name: "write over a directory",
			tool: createWriteTool,
			args: { path: ".", content: "x" },
			message: "Is directory",
		},
		{
			name: "write under a file",
			tool: createWriteTool,
			args: { path: "a.ts/child.txt", content: "x" },
			message: "Bad parent",
		},
		{
			name: "grep missing path",
			tool: createGrepTool,
			args: { pattern: "x", path: "nope" },
			message: "Path missing",
		},
		{
			name: "grep invalid pattern",
			tool: createGrepTool,
			args: { pattern: "(" },
			message: "Search failed",
		},
		{
			name: "find missing path",
			tool: createFindTool,
			args: { pattern: "*.ts", path: "nope" },
			message: "Path missing",
		},
		{
			name: "ls missing path",
			tool: createLsTool,
			args: { path: "nope" },
			message: "Path missing",
		},
		{
			name: "ls a file",
			tool: createLsTool,
			args: { path: "a.ts" },
			message: "Not a directory",
		},
		{
			name: "read broken image",
			tool: createReadTool,
			args: { path: "broken.png" },
			message: "Image omitted",
		},
	];
}

describe("tool failures", () => {
	let cwd: string;
	beforeAll(async () => {
		initTheme("dark");
		cwd = await mkdtemp(join(tmpdir(), "gama-tool-failures-"));
		await writeFile(join(cwd, "a.ts"), "const value = 1;\nconst value = 1;\n");
		// Bad png
		const pngHeader = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
			0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0,
		]);
		await writeFile(join(cwd, "broken.png"), pngHeader);
	});

	it("marks every failure as an error with a natural message", async () => {
		for (const failure of cases()) {
			const { outcome, text } = await audit(cwd, failure);
			expect(outcome.isError, failure.name).toBe(true);
			expect(text, failure.name).toContain(failure.message);
			expect(text, failure.name).not.toMatch(/\.$/);
			expect(text, failure.name).not.toMatch(/[()]/);
		}
	});

	it("reads as a failure in the activity row", async () => {
		for (const failure of cases()) {
			const row = formatActivityLine(
				{
					toolCallId: failure.name,
					name: failure.tool(cwd).name,
					args: failure.args,
					status: "error",
					timestamp: Date.now(),
				},
				cwd,
			);
			expect(row, failure.name).toContain("failed");
		}
	});

	it("explains a failed git command", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(
					Buffer.from(
						"fatal: not a git repository (or any of the parent directories): .git\n",
						"utf-8",
					),
				);
				return { exitCode: 128 };
			},
		};
		const result = await createBashTool(cwd, { operations }).execute("test-git", {
			command: "git status",
			timeout: 10, // Mocked
		});
		const text = (result.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");

		expect(result.isError).toBe(true);
		expect(text).toContain("Reason: No git");
		expect(text).toContain("Next: Git init");
		expect(result.structuredContent).toMatchObject({
			error: "No git",
			hint: "Git init",
			exit_code: 128,
		});
	});
});
