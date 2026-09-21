import { createInterface } from "node:readline";
import type { AgentTool } from "@huranth/gama-agent-core";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import { exitCodeLabel } from "../exit-code.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
import { findRenderers } from "./ui/find.ts";

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

export interface FindOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	glob: (
		pattern: string,
		cwd: string,
		options: { ignore: string[]; limit: number },
	) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	operations?: FindOperations;
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(
		Type.String({ description: "Directory to search in (default: current directory)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export const findToolSystemPromptContribution = {
	snippet: "Find files by glob pattern (respects .gitignore)",
	guidelines: [],
} as const;

const DEFAULT_LIMIT = 1000;

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	glob: () => [],
};

export function createFindTool(
	cwd: string,
	options?: FindToolOptions,
): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}

export function relativizeFindResultPath(
	resultPath: string,
	searchPath: string,
	pathModule: Pick<typeof path, "sep" | "isAbsolute" | "relative"> = path,
): string {
	const hadTrailingSeparator =
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	const relativePath = pathModule.isAbsolute(resultPath)
		? pathModule.relative(searchPath, resultPath)
		: resultPath;
	const posixPath = relativePath.split(pathModule.sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

function summarizeFindResults(
	results: string[],
	searchPath: string,
	limit: number,
	suggestMore: boolean,
) {
	const relativized = results.map((line) => relativizeFindResultPath(line, searchPath));

	if (relativized.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No files found matching pattern" }],
			details: undefined,
		};
	}

	const truncation = truncateHead(relativized.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const details: FindToolDetails = {};
	const notices: string[] = [];

	if (relativized.length >= limit) {
		notices.push(
			suggestMore
				? `${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`
				: `${limit} results limit reached`,
		);
		details.resultLimitReached = limit;
	}

	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}

	let output = truncation.content;
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text" as const, text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description:
			"Search for files by glob pattern. Returns matching file paths relative to " +
			"the search directory. Respects .gitignore. Output is truncated to " +
			`${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const ops = customOps ?? defaultFindOperations;

						if (!(await ops.exists(searchPath))) {
							settle(() => reject(new Error(`Could not find ${searchPath}`)));
							return;
						}

						if (customOps?.glob) {
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}

							settle(() =>
								resolve(summarizeFindResults(results, searchPath, effectiveLimit, false)),
							);
							return;
						}

						const fdPath = await ensureTool("fd");
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() =>
								reject(new Error("Could not find fd, it is needed to find files")),
							);
							return;
						}

						const args: string[] = ["--glob", "--color=never", "--hidden"];

						let insideGitRepo = false;
						for (let current = searchPath; ; ) {
							if (await ops.exists(path.join(current, ".git"))) {
								insideGitRepo = true;
								break;
							}
							const parent = path.dirname(current);
							if (parent === current) break;
							current = parent;
						}
						if (!insideGitRepo) args.push("--no-require-git");
						args.push("--max-results", String(effectiveLimit));

						let effectivePattern = pattern;
						if (pattern.includes("/")) {
							args.push("--full-path");
							if (
								!pattern.startsWith("/") &&
								!pattern.startsWith("**/") &&
								pattern !== "**"
							) {
								effectivePattern = `**/${pattern}`;
							}
							if (process.platform === "win32")
								effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
						}
						args.push("--", effectivePattern, searchPath);

						const child = spawn(fdPath, args, {
							stdio: ["ignore", "pipe", "pipe"],
							windowsHide: true,
						});
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Could not run fd, ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();

							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (code !== 0) {
								const last = stderr.trim().split("\n").pop() ?? "";
								const reason = last.replace(/^\[fd error\]:\s*/i, "");
								settle(() =>
									reject(
										new Error(
											reason
												? `Could not find files, ${reason}`
												: `Could not find files, ${exitCodeLabel(code ?? 1)}`,
										),
									),
								);
								return;
							}

							const cleanLines = lines
								.map((line) => line.replace(/\r$/, "").trim())
								.filter((line) => line.length > 0);

							settle(() =>
								resolve(summarizeFindResults(cleanLines, searchPath, effectiveLimit, true)),
							);
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		...findRenderers,
	};
}
