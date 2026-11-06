import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@huranth/gama-agent-core";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { ABORT_MESSAGE, assertNotAborted } from "./abort.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
import { findRenderers } from "./ui/find.ts";

const DEFAULT_LIMIT = 1000;

const BYTES_PER_KB = 1024;

const MIN_LIMIT = 1;

const LIMIT_FACTOR = 2;

const DEFAULT_IGNORES = ["**/node_modules/**", "**/.git/**"];

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(
		Type.String({ description: "Directory to search in (default: current directory)" }),
	),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of results (default: ${DEFAULT_LIMIT})` }),
	),
});

export type FindToolInput = Static<typeof findSchema>;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultCount?: number;
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

type FdArgsInput = {
	pattern: string;
	searchPath: string;
	limit: number;
	ops: FindOperations;
};

type PatternArgs = {
	effectivePattern: string;
	fullPath: boolean;
};

export const findToolSystemPromptContribution = {
	snippet: "Find files by glob pattern (respects .gitignore)",
	guidelines: [],
} as const;

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	glob: () => [],
};

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;

	return Math.max(MIN_LIMIT, Math.floor(limit));
}

export function relativizeFindResultPath(
	resultPath: string,
	searchPath: string,
	pathModule: Pick<typeof path, "sep" | "isAbsolute" | "relative" | "basename"> = path,
): string {
	const hadTrailingSeparator =
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	const relativePath = pathModule.isAbsolute(resultPath)
		? pathModule.relative(searchPath, resultPath)
		: resultPath;
	// Cross-drive
	const normalizedPath = pathModule.isAbsolute(relativePath)
		? pathModule.basename(relativePath)
		: relativePath;

	const posixPath = normalizedPath.split(pathModule.sep).join("/");

	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

function resolvePattern(normalizedPattern: string): PatternArgs {
	const fullPath = normalizedPattern.includes("/");
	const rooted =
		normalizedPattern.startsWith("/") ||
		normalizedPattern.startsWith("**/") ||
		normalizedPattern === "**";
	const prefixNeeded = fullPath && !rooted;

	return {
		effectivePattern: prefixNeeded ? `**/${normalizedPattern}` : normalizedPattern,
		fullPath,
	};
}

async function hasGitDir(startPath: string, ops: FindOperations): Promise<boolean> {
	let current = startPath;

	while (true) {
		if (await ops.exists(path.join(current, ".git"))) return true;

		const parent = path.dirname(current);
		if (parent === current) return false;

		current = parent;
	}
}

async function buildFdArgs(input: FdArgsInput): Promise<string[]> {
	const args = ["--glob", "--color=never", "--hidden", "--exclude", ".git"];

	if (!(await hasGitDir(input.searchPath, input.ops))) args.push("--no-require-git");

	args.push("--max-results", String(input.limit));

	const normalizedPattern =
		process.platform === "win32" ? input.pattern.replaceAll("\\", "/") : input.pattern;
	const { effectivePattern, fullPath } = resolvePattern(normalizedPattern);

	if (fullPath) args.push("--full-path");

	args.push("--", effectivePattern, input.searchPath);

	return args;
}

function summarizeFindResults(
	results: string[],
	searchPath: string,
	limit: number,
	suggestMore: boolean,
) {
	const hasMore = results.length > limit;
	const visible = hasMore ? results.slice(0, limit) : results;
	const relativized = visible.map((line) => relativizeFindResultPath(line, searchPath));

	if (relativized.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No files found matching pattern" }],
			details: { resultCount: 0 },
		};
	}

	const truncation = truncateHead(relativized.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const details: FindToolDetails = { resultCount: relativized.length };
	const notices: string[] = [];

	if (hasMore) {
		notices.push(limitNotice(limit, suggestMore));
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

function limitNotice(limit: number, suggestMore: boolean): string {
	if (!suggestMore) return `${limit} results limit reached`;

	return (
		`${limit} results limit reached. ` +
		`Use limit=${limit * LIMIT_FACTOR} for more, or refine pattern`
	);
}

function cleanLines(lines: string[]): string[] {
	return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
}

function findError(stderr: string, cause?: unknown): Error {
	const last = stderr.trim().split("\n").pop() ?? "";
	const reason = last.replace(/^(?:\[fd[^\]]*\]|fd):\s*/, "").trim();
	const spawnCause = cause instanceof Error ? cause.message.trim() : "";
	const detail = [reason, spawnCause].filter(Boolean).join(" ");

	return new Error(detail ? `Find failed: ${detail}` : "Find failed");
}

function runFd(
	fdPath: string,
	args: string[],
	searchPath: string,
	limit: number,
	signal: AbortSignal | undefined,
) {
	if (signal?.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

	return new Promise<ReturnType<typeof summarizeFindResults>>((resolve, reject) => {
		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const rl = createInterface({ input: child.stdout });
		const lines: string[] = [];
		let stderr = "";

		const cleanup = () => rl.close();

		const onAbort = () => {
			if (!child.killed) child.kill();

			cleanup();
			reject(new Error(ABORT_MESSAGE));
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		rl.on("line", (line) => {
			lines.push(line);
		});

		child.on("error", (error) => {
			cleanup();
			reject(findError(stderr, error));
		});

		child.on("close", (code) => {
			cleanup();
			signal?.removeEventListener("abort", onAbort);

			if (signal?.aborted) {
				reject(new Error(ABORT_MESSAGE));
				return;
			}

			if (code !== 0) {
				reject(findError(stderr));
				return;
			}

			resolve(summarizeFindResults(cleanLines(lines), searchPath, limit, true));
		});
	});
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
			"the search directory. Respects .gitignore. Globs use /; on Windows, backslashes become /. " +
			"Match a literal [ with a character class, e.g. q[[]1[]]. Output is truncated to " +
			`${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / BYTES_PER_KB}KB (whichever is hit first).`,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			assertNotAborted(signal);

			const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
			const effectiveLimit = normalizeLimit(limit);
			const ops = customOps ?? defaultFindOperations;

			if (!(await ops.exists(searchPath))) {
				throw new Error("Path missing");
			}

			assertNotAborted(signal);

			if (customOps?.glob) {
				const results = await ops.glob(pattern, searchPath, {
					ignore: DEFAULT_IGNORES,
					limit: effectiveLimit + 1,
				});

				assertNotAborted(signal);

				return summarizeFindResults(results, searchPath, effectiveLimit, false);
			}

			const fdPath = await ensureTool("fd");

			assertNotAborted(signal);

			if (!fdPath) throw new Error("Fd missing");

			const args = await buildFdArgs({
				pattern,
				searchPath,
				limit: effectiveLimit + 1,
				ops,
			});

			assertNotAborted(signal);

			return runFd(fdPath, args, searchPath, effectiveLimit, signal);
		},
		...findRenderers,
	};
}

export function createFindTool(
	cwd: string,
	options?: FindToolOptions,
): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
