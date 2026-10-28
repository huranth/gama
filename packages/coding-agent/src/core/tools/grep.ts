import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@huranth/gama-agent-core";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";
import { grepRenderers } from "./ui/grep.ts";

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

export interface GrepOperations {
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	readFile: (absolutePath: string) => Promise<string> | string;
}

export interface GrepToolOptions {
	operations?: GrepOperations;
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(
		Type.String({ description: "Directory or file to search (default: current directory)" }),
	),
	glob: Type.Optional(
		Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
	),
	ignoreCase: Type.Optional(
		Type.Boolean({ description: "Case-insensitive search (default: false)" }),
	),
	literal: Type.Optional(
		Type.Boolean({
			description: "Treat pattern as literal string instead of regex (default: false)",
		}),
	),
	context: Type.Optional(
		Type.Number({
			description: "Number of lines to show before and after each match (default: 0)",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of matches to return (default: 100)" }),
	),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

const DEFAULT_LIMIT = 100;

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export function createGrepTool(
	cwd: string,
	options?: GrepToolOptions,
): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}

function summarizeMatches(input: {
	lines: string[];
	limit: number;
	matchLimitReached: boolean;
	linesTruncated: boolean;
	searchErrors?: string[];
}) {
	const truncation = truncateHead(input.lines.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const details: GrepToolDetails = {};
	const notices: string[] = [];

	if (input.matchLimitReached) {
		notices.push(
			`${input.limit} matches limit reached. ` +
				`Use limit=${input.limit * 2} for more, or refine pattern`,
		);
		details.matchLimitReached = input.limit;
	}

	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}

	if (input.linesTruncated) {
		notices.push(
			`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
		);
		details.linesTruncated = true;
	}

	if (input.searchErrors?.length) {
		notices.push(`Some paths could not be searched: ${input.searchErrors.join("; ")}`);
	}

	let output = truncation.content;
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text" as const, text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

const MAX_REPORTED_ERRORS = 3;

function stderrLines(stderr: string): string[] {
	const lines = stderr
		.split("\n")
		.map((line) => line.trim().replace(/^rg:\s*/, ""))
		.filter(Boolean);
	if (lines.length <= MAX_REPORTED_ERRORS) return lines;
	return [
		...lines.slice(0, MAX_REPORTED_ERRORS),
		`${lines.length - MAX_REPORTED_ERRORS} more errors`,
	];
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and " +
			`line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} ` +
			`matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). ` +
			`Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg");
						if (!rgPath) {
							settle(() =>
								reject(new Error("Could not find ripgrep, it is needed to search files")),
							);
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Could not find ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const args: string[] = [
							"--json",
							"--line-number",
							"--color=never",
							"--hidden",
							"--glob",
							"!.git",
						];

						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);

						args.push("--", pattern, searchPath);

						const child = spawn(rgPath, args, {
							stdio: ["ignore", "pipe", "pipe"],
							windowsHide: true,
						});
						const rl = createInterface({ input: child.stdout });

						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};

						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};

						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (
							filePath: string,
							lineNumber: number,
						): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) {
								return [`${relativePath}:${lineNumber}: (unable to read file)`];
							}

							const block: string[] = [];
							const start =
								contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end =
								contextValue > 0
									? Math.min(lines.length, lineNumber + contextValue)
									: lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						const matches: Array<{
							filePath: string;
							lineNumber: number;
							lineText?: string;
						}> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) {
								return;
							}

							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number") {
									matches.push({ filePath, lineNumber, lineText });
								}

								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Could not run ripgrep, ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();

							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							// rg exits 2 when some paths fail but others matched; keep those matches.
							const partial = code === 2 && matchCount > 0;
							if (!killedDueToLimit && code !== 0 && code !== 1 && !partial) {
								const last = stderr.trim().split("\n").pop() ?? "";
								const reason = last
									.replace(/^(?:rg|grep):\s*/, "")
									.replace(/^error:\s*/, "");
								settle(() =>
									reject(
										new Error(
											reason
												? `Could not search, ${reason}`
												: "Could not search the files",
										),
									),
								);
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No matches found" }],
										details: undefined,
									}),
								);
								return;
							}

							for (const match of matches) {
								if (contextValue === 0 && match.lineText !== undefined) {
									const relativePath = formatPath(match.filePath);
									const sanitized = match.lineText
										.replace(/\r\n/g, "\n")
										.replace(/\r/g, "")
										.replace(/\n$/, "");
									const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
									if (wasTruncated) linesTruncated = true;
									outputLines.push(
										`${relativePath}:${match.lineNumber}: ${truncatedText}`,
									);
								} else {
									const block = await formatBlock(match.filePath, match.lineNumber);
									outputLines.push(...block);
								}
							}

							settle(() =>
								resolve(
									summarizeMatches({
										lines: outputLines,
										limit: effectiveLimit,
										matchLimitReached,
										linesTruncated,
										searchErrors: partial ? stderrLines(stderr) : undefined,
									}),
								),
							);
						});
					} catch (err) {
						settle(() => reject(err));
					}
				})();
			});
		},
		...grepRenderers,
	};
}
