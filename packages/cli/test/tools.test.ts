import { applyPatch } from "diff";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ExtensionToolContext } from "../src/core/ext/types.ts";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";
import * as shellModule from "../src/utils/shell.ts";

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

function fakeCtx(cwd: string): ExtensionToolContext {
	return { cwd } as ExtensionToolContext;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});

		it("handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(
				/File missing/,
			);
		});

		it("truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		it("truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			expect(output).toMatch(
				/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/,
			);
		});

		it("handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			expect(output).not.toContain("Use offset=");
		});

		it("reject an offset that is not a positive integer", async () => {
			const testFile = join(testDir, "bad-offset.txt");
			writeFileSync(testFile, "Line 1\nLine 2");

			for (const offset of [0, -1, 1.5]) {
				await expect(
					readTool.execute("test-call-offset", { path: testFile, offset }),
				).rejects.toThrow(/Bad offset/);
			}
		});

		it("handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		it("handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(
				readTool.execute("test-call-8", { path: testFile, offset: 100 }),
			).rejects.toThrow(/Offset too big/);
		});

		it("include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		it("detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwAB" +
				"BAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("read BMP files from disk as PNG image attachments", async () => {
			const testFile = join(testDir, "image.bmp");
			writeFileSync(testFile, createTinyBmp1x1Red24bpp());

			const result = await readTool.execute("test-call-img-bmp", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");
			expect(getTextOutput(result)).toContain("[Image converted from image/bmp to image/png.]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(Buffer.from(imageBlock?.data ?? "", "base64")[0]).toBe(0x89);
		});

		it("treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toBe(`Created ${testFile}`);
			expect(result.details).toEqual({ created: true });
		});

		it("create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Created ");
		});
	});

	describe("edit tool", () => {
		it("replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			expect(getTextOutput(result)).toContain("Edited 1 block");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
			expect(result.details.patch).toContain("--- ");
			expect(result.details.patch).toContain("+++ ");
			expect(result.details.patch).toContain("@@");
			expect(result.details.patch).toContain("-Hello, world!");
			expect(result.details.patch).toContain("+Hello, testing!");
			expect(applyPatch(originalContent, result.details.patch)).toBe("Hello, testing!");
		});

		it("tail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
			).rejects.toThrow(/Text missing/);
		});

		it("include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await expect(
				editTool.execute("test-call-6b", {
					path: missingFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("File missing");
		});

		it("tail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow(/Duplicate text/);
		});

		it("replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			});

			expect(getTextOutput(result)).toContain("Edited 2 blocks");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from(
				{ length: 600 },
				(_, i) => `line ${String(i + 1).padStart(3, "0")}`,
			);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ oldText: "line 100\n", newText: "LINE 100\n" },
					{ oldText: "line 300\n", newText: "LINE 300\n" },
					{ oldText: "line 500\n", newText: "LINE 500\n" },
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		it("catch edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("tail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/No edits/);
		});

		it("tail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		it("not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
			).rejects.toThrow(/Text missing/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await expect(
				editTool.execute("test-call-14", {
					path: testFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("Edit denied");
		});

		it("include the original error message for unknown edit access errors", async () => {
			const genericFailureTool = createEditTool(testDir, {
				operations: {
					access: async () => {
						throw new Error("disk offline");
					},
					readFile: async () => Buffer.from("hello\n", "utf-8"),
					writeFile: async () => {},
				},
			});

			await expect(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("Edit failed");
		});

		it("include ENOENT in diff preview for missing files", async () => {
			const missingFile = join(testDir, "missing-preview.txt");
			const result = await computeEditsDiff(
				missingFile,
				[{ oldText: "hello", newText: "world" }],
				testDir,
			);

			expect(result).toEqual({
				error: "File missing",
			});
		});
	});

	describe("bash tool", () => {
		it("execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", {
				command: "echo 'test output'",
				timeout: 30,
			});

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("report non-zero exit codes as error results with structured content", async () => {
			const result = await bashTool.execute("test-call-9", {
				command: "echo out; exit 3",
				timeout: 30,
			});
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toBe(
				"out\n\n\nCommand failed\nReason: Exit 3\n" + "Next: Check script logic",
			);
			expect(result.structuredContent).toEqual({
				output: "out\n",
				truncated: false,
				exit_code: 3,
				error: "Exit 3",
				hint: "Check script logic",
				wall_time_seconds: expect.any(Number),
			});

			const ok = await bashTool.execute("test-call-9b", { command: "echo fine", timeout: 30 });
			expect(ok.isError).toBeUndefined();
			expect(ok.structuredContent).toMatchObject({ output: "fine\n", exit_code: 0 });

			const empty = await bashTool.execute("test-call-9c", { command: "true", timeout: 30 });
			expect(getTextOutput(empty)).toBe("No output");
			expect(empty.structuredContent).toMatchObject({ output: "", truncated: false });
		});

		it("return up to 1 MiB of output in structured content", async () => {
			const medium = await bashTool.execute("test-call-9d", {
				command: "seq 1 3000",
				timeout: 30,
			});
			expect(getTextOutput(medium)).not.toContain("\n1\n2\n");
			expect(medium.details?.truncation?.truncated).toBe(true);
			const mediumOutput = medium.structuredContent as { output: string; truncated: boolean };
			expect(mediumOutput.truncated).toBe(false);
			expect(mediumOutput.output).toBe(
				`${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`,
			);

			const large = await bashTool.execute("test-call-9e", {
				command: "seq 1 300000",
				timeout: 60,
			});
			const largeOutput = large.structuredContent as {
				output: string;
				truncated: boolean;
				full_output_path?: string;
			};
			expect(largeOutput.truncated).toBe(true);
			expect(largeOutput.output.startsWith("1\n2\n3\n")).toBe(true);
			expect(largeOutput.output.endsWith("299999\n300000\n")).toBe(true);
			expect(largeOutput.output).toMatch(/\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/);
			expect(Buffer.byteLength(largeOutput.output)).toBeLessThan(1024 * 1024 + 100);
			expect(largeOutput.full_output_path).toBe(large.details?.fullOutputPath);
			expect(readFileSync(largeOutput.full_output_path!, "utf-8").endsWith("300000\n")).toBe(
				true,
			);
		});

		it("reject a null exit code from custom operations", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("partial\n", "utf-8"));
					return { exitCode: null };
				},
			};
			const bash = createBashTool(testDir, { operations });

			await expect(
				bash.execute("test-call-null-exit", { command: "remote", timeout: 30 }),
			).rejects.toThrow(/partial[\s\S]*Command failed[\s\S]*Reason: No exit/);
		});

		it("respect timeout", async () => {
			const script = JSON.stringify("setInterval(() => {}, 1000)");
			const command = `${JSON.stringify(process.execPath)} -e ${script}`;
			await expect(bashTool.execute("test-call-10", { command, timeout: 0.05 })).rejects.toThrow(
				/timed out/i,
			);
		});

		it("include full output path for truncated timeout and abort errors", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "Timed out 5s" },
				{ error: "aborted", expected: "Command aborted" },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"));
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				let error: unknown;
				try {
					await bash.execute(`test-call-${testCase.error}`, {
						command: "chatty-fail",
						timeout: 30,
					});
				} catch (err) {
					error = err;
				}

				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain(testCase.expected);
				expect(message).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
				expect(message).not.toContain("Full output: undefined");
				const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		it("throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(
				bashToolWithBadCwd.execute("test-call-11", { command: "echo test", timeout: 30 }),
			).rejects.toThrow(/Cwd missing/);
		});

		it("handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(
				bashWithBadShell.execute("test-call-12", { command: "echo test", timeout: 30 }),
			).rejects.toThrow(/Shell missing/);
		});

		it("pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test", timeout: 30 });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Invalid shell path");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("send commands over stdin when shell resolution requires it", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: [
					"-e",
					'let input = ""; process.stdin.setEncoding("utf8"); ' +
						'process.stdin.on("data", (chunk) => { input += chunk; }); ' +
						'process.stdin.on("end", () => { process.stdout.write(input); });',
				],
				commandTransport: "stdin",
			});
			const chunks: Buffer[] = [];
			const ops = createLocalBashOperations({ shellPath: "C:\\Windows\\System32\\bash.exe" });
			const nameExpansion = "$" + "{name}";
			const countExpansion = "$" + "{count}";
			const iExpansion = "$" + "{i}";
			const command =
				`name='World'; echo "Hello, ${nameExpansion}!"; count=3; ` +
				`for i in $(seq 1 ${countExpansion}); do ` +
				`echo "Iteration ${iExpansion} of ${countExpansion}"; done`;

			const result = await ops.exec(command, testDir, {
				onData: (data) => chunks.push(data),
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8")).toBe(command);
		});

		it("resolve legacy WSL bash.exe to stdin command transport", () => {
			if (process.platform === "win32") return;
			const originalCwd = process.cwd();
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			const shellPath = "C:\\Windows\\System32\\bash.exe";
			writeFileSync(join(testDir, shellPath), "");
			try {
				process.chdir(testDir);
				Object.defineProperty(process, "platform", {
					configurable: true,
					value: "win32",
				});

				expect(shellModule.getShellConfig(shellPath)).toEqual({
					shell: shellPath,
					args: ["-s"],
					commandTransport: "stdin",
				});
			} finally {
				process.chdir(originalCwd);
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
			}
		});

		it("prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", {
				command: "echo $TEST_VAR",
				timeout: 30,
			});
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", {
				command: "echo command-output",
				timeout: 30,
			});
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("fork without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", {
				command: "echo no-prefix",
				timeout: 30,
			});
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{
				content: Array<{ type: string; text?: string }>;
				details?: unknown;
			}> = [];
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute(
				"test-call-chatty-updates",
				{ command: "chatty", timeout: 30 },
				undefined,
				(update) => updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		it("not count a trailing newline as an extra truncated bash output line", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 1; i <= 4000; i++) {
						onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-trailing-newline-line-count", {
				command: "many-lines",
				timeout: 30,
			});
			const output = getTextOutput(result);

			expect(result.details?.truncation?.totalLines).toBe(4000);
			expect(result.details?.truncation?.outputLines).toBe(2000);
			expect(output).toContain("line-2001");
			expect(output).toContain("line-4000");
			expect(output).toMatch(/\[Showing lines 2001-4000 of 4000\. Full output: /);
			expect(output).not.toContain("4001");
		});

		it("decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", {
				command: "split-utf8",
				timeout: 30,
			});

			expect(getTextOutput(result).trim()).toBe("€");
		});

		it("expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("flushes an incomplete UTF-8 sequence in executeBash output", async () => {
			const chunks: string[] = [];
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from([0xe2, 0x82]));
					return { exitCode: 0 };
				},
			};
			const result = await executeBashWithOperations("test", testDir, operations, {
				onChunk: (chunk) => chunks.push(chunk),
			});

			expect(result.output).toBe("�");
			expect(chunks.join("")).toBe(result.output);
		});

		it("persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", {
				command: "seq 3000",
				timeout: 30,
			});
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it(
			"executeBash should persist full output when truncation happens by line " + "count only",
			async () => {
				const result = await executeBashWithOperations(
					"seq 3000",
					process.cwd(),
					createLocalBashOperations(),
				);
				const fullOutputPath = result.fullOutputPath;

				expect(result.truncated).toBe(true);
				expect(fullOutputPath).toBeDefined();

				for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}

				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			},
		);
	});

	describe("grep tool", () => {
		it("include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join(
				"\n",
			);
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain(
				"[1 matches limit reached. Use limit=2 for more, or refine pattern]",
			);
			expect(output).not.toContain("match two");
		});

		it("not search inside .git", async () => {
			mkdirSync(join(testDir, ".git", "hooks"), { recursive: true });
			writeFileSync(join(testDir, ".git", "hooks", "pre-commit.sample"), "needle in git\n");
			writeFileSync(join(testDir, "src.txt"), "needle in src\n");

			const output = getTextOutput(
				await grepTool.execute("test-call-grep-dot-git", { pattern: "needle", path: testDir }),
			);

			expect(output).toContain("src.txt:1: needle in src");
			expect(output).not.toContain(".git");
		});

		it("treat flag-like patterns as search text", async () => {
			const marker = join(testDir, "grep-injection-marker");
			const payload = join(testDir, "payload.sh");
			const testFile = join(testDir, "target.txt");
			writeFileSync(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
			chmodSync(payload, 0o755);
			writeFileSync(testFile, "target\n");

			const result = await grepTool.execute("test-call-grep-injection", {
				pattern: `--pre=${payload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No matches found");
			expect(existsSync(marker)).toBe(false);
		});
	});

	describe("find tool", () => {
		it("include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("not list .git contents", async () => {
			mkdirSync(join(testDir, ".git", "hooks"), { recursive: true });
			writeFileSync(join(testDir, ".git", "hooks", "pre-commit.sample"), "x");
			writeFileSync(join(testDir, "src.txt"), "x");

			const output = getTextOutput(
				await findTool.execute("test-call-find-dot-git", { pattern: "**/*", path: testDir }),
			);

			expect(output).toContain("src.txt");
			expect(output).not.toContain(".git");
		});

		it("respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("surface fd glob parse errors", async () => {
			await expect(
				findTool.execute("test-call-15", {
					pattern: "[",
					path: testDir,
				}),
			).rejects.toThrow(/Find failed: error parsing glob/);
		});

		it("treat flag-like patterns as search text", async () => {
			const result = await findTool.execute("test-call-find-flag-pattern", {
				pattern: "--help",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No files found matching pattern");
		});

		it("use injected operations to check the search path", async () => {
			const tool = createFindToolDefinition("/", {
				operations: { exists: () => false, glob: () => [] },
			});

			await expect(
				tool.execute(
					"test-call-find-missing",
					{ pattern: "*.ts", path: "/missing" },
					undefined,
					undefined,
					{} as Parameters<typeof tool.execute>[4],
				),
			).rejects.toThrow(/Path missing/);
		});
	});

	describe("ls tool", () => {
		it("list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

describe("tool cwd resolution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-cwd-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("read uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-read.txt");
		writeFileSync(testFile, "hello from ctx.cwd");
		const tool = createReadToolDefinition("/");
		const result = await tool.execute(
			"test-read-ctx-cwd",
			{ path: "ctx-cwd-read.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("hello from ctx.cwd");
	});

	it("write uses ctx.cwd when provided", async () => {
		const tool = createWriteToolDefinition("/");
		await tool.execute(
			"test-write-ctx-cwd",
			{ path: "ctx-cwd-write.txt", content: "written via ctx.cwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(join(testDir, "ctx-cwd-write.txt"), "utf-8");
		expect(content).toBe("written via ctx.cwd");
	});

	it("edit uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-edit.txt");
		writeFileSync(testFile, "old text");
		const tool = createEditToolDefinition("/");
		await tool.execute(
			"test-edit-ctx-cwd",
			{ path: "ctx-cwd-edit.txt", edits: [{ oldText: "old text", newText: "new text" }] },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("new text");
	});

	it("edit does not report aborted after the file was written", async () => {
		const testFile = join(testDir, "abort-after-write.txt");
		writeFileSync(testFile, "old text");
		const controller = new AbortController();
		const tool = createEditToolDefinition("/", {
			operations: {
				access: async () => {},
				readFile: async (path) => readFileSync(path),
				writeFile: async (path, content) => {
					writeFileSync(path, content);
					controller.abort();
				},
			},
		});

		const result = await tool.execute(
			"test-edit-abort",
			{ path: testFile, edits: [{ oldText: "old text", newText: "new text" }] },
			controller.signal,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);

		expect(getTextOutput(result)).toContain("Edited 1 block");
		expect(readFileSync(testFile, "utf-8")).toBe("new text");
	});

	it("grep uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-grep.txt");
		writeFileSync(testFile, "match in ctx.cwd");
		const tool = createGrepToolDefinition("/");
		const result = await tool.execute(
			"test-grep-ctx-cwd",
			{ pattern: "match" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-grep.txt");
	});

	it("find uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-find.txt"), "find me");
		const tool = createFindToolDefinition("/");
		const result = await tool.execute(
			"test-find-ctx-cwd",
			{ pattern: "ctx-cwd-find.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-find.txt");
	});

	it("ls uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-ls.txt"), "list me");
		const tool = createLsToolDefinition("/");
		const result = await tool.execute(
			"test-ls-ctx-cwd",
			{},
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-ls.txt");
	});

	it("bash uses ctx.cwd when provided", async () => {
		const tool = createBashToolDefinition("/", { exposeSessionEnvironment: false });
		const result = await tool.execute(
			"test-bash-ctx-cwd",
			{ command: "pwd", timeout: 30 },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain(basename(testDir));
	});
});

describe("edit tool fuzzy matching", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("catch text with trailing whitespace stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		writeFileSync(testFile, "line one   \nline two  \nline three\n");

		const result = await editTool.execute("test-fuzzy-1", {
			path: testFile,
			edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("replaced\nline three\n");
	});

	it("catch fullwidth punctuation in Chinese text", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		writeFileSync(testFile, "你好，世界\n你好（世界）\n");

		const result = await editTool.execute("test-fuzzy-chinese", {
			path: testFile,
			edits: [
				{
					oldText: "你好,世界\n你好(世界)\n",
					newText: "你好，gama\n你好(gama)\n",
				},
			],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("你好，gama\n你好(gama)\n");
	});

	it("catch compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		writeFileSync(testFile, "ＡＢＣ１２３\ncafe\u0301\n");

		const result = await editTool.execute("test-fuzzy-unicode", {
			path: testFile,
			edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("XYZ789\ncoffee\n");
	});

	it("catch smart single quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\n");

		const result = await editTool.execute("test-fuzzy-2", {
			path: testFile,
			edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("world");
	});

	it("catch smart double quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		writeFileSync(testFile, "const msg = \u201CHello World\u201D;\n");

		const result = await editTool.execute("test-fuzzy-3", {
			path: testFile,
			edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("Goodbye");
	});

	it("catch Unicode dashes to ASCII hyphen", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		writeFileSync(testFile, "range: 1\u20135\nbreak\u2014here\n");

		const result = await editTool.execute("test-fuzzy-4", {
			path: testFile,
			edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("10-50");
	});

	it("catch non-breaking space to regular space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		writeFileSync(testFile, "hello\u00A0world\n");

		const result = await editTool.execute("test-fuzzy-5", {
			path: testFile,
			edits: [{ oldText: "hello world", newText: "hello universe" }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("universe");
	});

	it("only replace the matched span and keep the rest of the line as written", async () => {
		const testFile = join(testDir, "fuzzy-same-line.txt");
		const originalContent = "x = \u201Ca\u201D + \u201Cb\u201D \u2122  \nnext\n";
		writeFileSync(testFile, originalContent);

		const result = await editTool.execute("test-fuzzy-same-line", {
			path: testFile,
			edits: [{ oldText: 'x = "a"', newText: 'y = "a"' }],
		});

		const expectedContent = 'y = "a" + \u201Cb\u201D \u2122  \nnext\n';
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
		expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
	});

	it("refuse a fuzzy match that cuts through an expanded character", async () => {
		const testFile = join(testDir, "fuzzy-cut-cluster.txt");
		writeFileSync(testFile, "a \u2122 b\n");

		await expect(
			editTool.execute("test-fuzzy-cut-cluster", {
				path: testFile,
				edits: [{ oldText: "T", newText: "X" }],
			}),
		).rejects.toThrow(/Exact text needed/);
		expect(readFileSync(testFile, "utf-8")).toBe("a \u2122 b\n");
	});

	it("prefer exact match over fuzzy match", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-fuzzy-6", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	it("still fail when text is not found even with fuzzy matching", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await expect(
			editTool.execute("test-fuzzy-7", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			}),
		).rejects.toThrow(/Text missing/);
	});

	it("detect duplicates after fuzzy normalization", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		writeFileSync(testFile, "hello world   \nhello world\n");

		await expect(
			editTool.execute("test-fuzzy-8", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			}),
		).rejects.toThrow(/Duplicate text/);
	});

	it("detect overlapping duplicate matches", async () => {
		const testFile = join(testDir, "overlapping-dups.txt");
		writeFileSync(testFile, "aaa\n");

		await expect(
			editTool.execute("test-overlap-dup", {
				path: testFile,
				edits: [{ oldText: "aa", newText: "b" }],
			}),
		).rejects.toThrow(/Duplicate text/);
	});

	it("support fuzzy matching in multi-edit mode", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\nhello\u00A0world\n");

		await editTool.execute("test-fuzzy-9", {
			path: testFile,
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
	});

	it(
		"preserveeserve the correct occurrence when fuzzy replacement equals a " + "nearby line",
		async () => {
			const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
			const originalContent = [
				"replace me\u0020\u0020\u0020",
				"after\u0020\u0020\u0020",
				"",
			].join("\n");
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-fuzzy-preserve-duplicate-line", {
				path: testFile,
				edits: [{ oldText: "replace me\n", newText: "after\n" }],
			});

			const expectedContent = ["after", "after\u0020\u0020\u0020", ""].join("\n");
			expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
			expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
		},
	);

	it(
		"preserveeserve untouched lines and produce an applicable patch for " + "fuzzy multi-edits",
		async () => {
			const testFile = join(testDir, "fuzzy-preserve-multi.txt");
			const originalContent = [
				"keep before\u0020\u0020",
				"first target\u0020\u0020",
				"first after",
				"keep middle\u0020\u0020\u0020",
				"second target\u0020\u0020",
				"second after",
				"keep after\u0020\u0020",
				"",
			].join("\n");
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-fuzzy-preserve-multi", {
				path: testFile,
				edits: [
					{ oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
					{ oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
				],
			});

			const expectedContent = [
				"keep before\u0020\u0020",
				"FIRST",
				"FIRST2",
				"keep middle\u0020\u0020\u0020",
				"SECOND",
				"SECOND2",
				"keep after\u0020\u0020",
				"",
			].join("\n");
			expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
			expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
		},
	);
});

describe("edit tool byte preservation", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-bytes-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("refuse to edit a file that is not valid UTF-8 and leave it untouched", async () => {
		const testFile = join(testDir, "latin1.txt");
		const original = Buffer.from([...Buffer.from("caf"), 0xe9, ...Buffer.from("\nfoo\n")]);
		writeFileSync(testFile, original);

		await expect(
			editTool.execute("test-non-utf8", {
				path: testFile,
				edits: [{ oldText: "foo", newText: "bar" }],
			}),
		).rejects.toThrow(/Bad encoding/);

		expect(readFileSync(testFile).equals(original)).toBe(true);
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("catch LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		});

		expect(getTextOutput(result)).toContain("Edited 1 block");
	});

	it("preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			}),
		).rejects.toThrow(/Duplicate text/);
	});

	it("leave other line endings alone in a file with mixed endings", async () => {
		const testFile = join(testDir, "mixed-preserve.txt");
		writeFileSync(testFile, "a\nb\r\nc\r\n");

		await editTool.execute("test-mixed-1", {
			path: testFile,
			edits: [{ oldText: "b", newText: "B" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("a\nB\r\nc\r\n");
	});

	it("leave lone CR line endings alone", async () => {
		const testFile = join(testDir, "lone-cr.txt");
		writeFileSync(testFile, "a\rb\rc");

		await editTool.execute("test-lone-cr", {
			path: testFile,
			edits: [{ oldText: "b", newText: "B" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("a\rB\rc");
	});

	it("catch a multi-line edit across a CRLF break in a mixed file", async () => {
		const testFile = join(testDir, "mixed-multiline.txt");
		writeFileSync(testFile, "x\r\ny\nz\r\n");

		await editTool.execute("test-mixed-2", {
			path: testFile,
			edits: [{ oldText: "x\ny", newText: "X\nY" }],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("X\nY\nz\r\n");
	});

	it("preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
