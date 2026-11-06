import { spawn } from "node:child_process";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@huranth/gama-agent-core";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { ABORT_MESSAGE, assertNotAborted } from "./abort.ts";
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

const DEFAULT_LIMIT = 100;

const BYTES_PER_KB = 1024;

const MIN_LIMIT = 1;

const LIMIT_FACTOR = 2;

const MAX_REPORTED_ERRORS = 3;

// Exit codes
const RG_MATCH_EXIT = 0;

const RG_NO_MATCH_EXIT = 1;

const RG_ERROR_EXIT = 2;

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
		Type.Number({
			description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT})`,
		}),
	),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	matchCount?: number;
	linesTruncated?: boolean;
}

export interface GrepOperations {
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	readFile: (absolutePath: string) => Promise<string> | string;
}

export interface GrepToolOptions {
	operations?: GrepOperations;
}

type GrepMatch = {
	filePath: string;
	lineNumber: number;
	lineText?: string;
};

type GrepArgsInput = {
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
};

type GrepSummaryInput = {
	lines: string[];
	limit: number;
	matchCount: number;
	matchLimitReached: boolean;
	linesTruncated: boolean;
	searchErrors?: string[];
};

type RipgrepState = {
	matches: GrepMatch[];
	matchCount: number;
	limitReached: boolean;
	stderr: string;
	exitCode: number | null;
};

type MatchBlockOptions = {
	context: number;
	searchPath: string;
	isDirectory: boolean;
	ops: GrepOperations;
	cache: Map<string, string[]>;
};

type RgEvent = {
	type: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
		lines?: { text?: string };
	};
};

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;

	return Math.max(MIN_LIMIT, Math.floor(limit));
}

function normalizeContext(context: number | undefined): number {
	if (context === undefined || !Number.isFinite(context) || context <= 0) return 0;

	return Math.floor(context);
}

function normalizeGlob(glob: string): string {
	// Windows glob
	return process.platform === "win32" ? glob.replaceAll("\\", "/") : glob;
}

function buildGrepArgs(input: GrepArgsInput): string[] {
	const args = ["--json", "--line-number", "--color=never", "--hidden", "--glob", "!.git"];

	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("--glob", normalizeGlob(input.glob));

	args.push("--", input.pattern, input.searchPath);

	return args;
}

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

function limitNotice(limit: number): string {
	return (
		`${limit} matches limit reached. Use limit=${limit * LIMIT_FACTOR} for more,` +
		` or refine pattern`
	);
}

function summarizeMatches(input: GrepSummaryInput) {
	const truncation = truncateHead(input.lines.join("\n"), {
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	const details: GrepToolDetails = { matchCount: input.matchCount };
	const notices: string[] = [];

	if (input.matchLimitReached) {
		notices.push(limitNotice(input.limit));
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

function noMatches() {
	return {
		content: [{ type: "text" as const, text: "No matches found" }],
		details: { matchCount: 0 },
	};
}

function matchPath(filePath: string, searchPath: string, isDirectory: boolean): string {
	if (!isDirectory) return path.basename(filePath);

	const relative = path.relative(searchPath, filePath);
	const inside =
		relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

	if (relative && inside) return relative.replace(/\\/g, "/");

	return path.basename(filePath);
}

async function fileLines(
	filePath: string,
	ops: GrepOperations,
	cache: Map<string, string[]>,
): Promise<string[]> {
	const cached = cache.get(filePath);
	if (cached) return cached;

	let lines: string[];
	try {
		const content = await ops.readFile(filePath);
		lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	} catch {
		lines = [];
	}

	cache.set(filePath, lines);

	return lines;
}

// Context block
async function matchBlock(
	match: GrepMatch,
	options: MatchBlockOptions,
): Promise<{ lines: string[]; truncated: boolean }> {
	const { context, searchPath, isDirectory, ops, cache } = options;
	const relativePath = matchPath(match.filePath, searchPath, isDirectory);
	const lines = await fileLines(match.filePath, ops, cache);

	if (lines.length === 0) {
		const missing = `${relativePath}:${match.lineNumber}: (unable to read file)`;

		return { lines: [missing], truncated: false };
	}

	const start = context > 0 ? Math.max(1, match.lineNumber - context) : match.lineNumber;
	const end = context > 0 ? Math.min(lines.length, match.lineNumber + context) : match.lineNumber;
	const block: string[] = [];
	let truncated = false;

	for (let current = start; current <= end; current++) {
		const lineText = (lines[current - 1] ?? "").replace(/\r/g, "");
		const { text, wasTruncated } = truncateLine(lineText);
		if (wasTruncated) truncated = true;

		if (current === match.lineNumber) block.push(`${relativePath}:${current}: ${text}`);
		else block.push(`${relativePath}-${current}- ${text}`);
	}

	return { lines: block, truncated };
}

function singleLineMatch(match: GrepMatch, searchPath: string, isDirectory: boolean) {
	const relativePath = matchPath(match.filePath, searchPath, isDirectory);
	const sanitized = (match.lineText ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "")
		.replace(/\n$/, "");
	const { text, wasTruncated } = truncateLine(sanitized);

	return {
		line: `${relativePath}:${match.lineNumber}: ${text}`,
		truncated: wasTruncated,
	};
}

// Stream reader
function readMatchEvent(
	line: string,
	state: RipgrepState,
	limit: number,
	onLimit: () => void,
): void {
	if (!line.trim() || state.matchCount >= limit) return;

	let event: RgEvent;
	try {
		event = JSON.parse(line) as RgEvent;
	} catch {
		return;
	}

	if (event.type !== "match") return;

	state.matchCount += 1;

	const filePath = event.data?.path?.text;
	const lineNumber = event.data?.line_number;
	const lineText = event.data?.lines?.text;

	if (filePath && typeof lineNumber === "number") {
		state.matches.push({ filePath, lineNumber, lineText });
	}

	if (state.matchCount >= limit) {
		state.limitReached = true;
		onLimit();
	}
}

function collectRipgrep(
	rgPath: string,
	args: string[],
	limit: number,
	signal: AbortSignal | undefined,
): Promise<RipgrepState> {
	return new Promise((resolve, reject) => {
		const child = spawn(rgPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const rl = createInterface({ input: child.stdout });
		const state: RipgrepState = {
			matches: [],
			matchCount: 0,
			limitReached: false,
			stderr: "",
			exitCode: null,
		};

		const stopChild = (dueToLimit = false) => {
			if (child.killed) return;

			if (dueToLimit) state.limitReached = true;

			child.kill();
		};

		const onAbort = () => {
			stopChild();
			reject(new Error(ABORT_MESSAGE));
		};

		const cleanup = () => {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });

		child.stderr?.on("data", (chunk) => {
			state.stderr += chunk.toString();
		});

		rl.on("line", (line) => {
			readMatchEvent(line, state, limit, () => stopChild(true));
		});

		child.on("error", () => {
			cleanup();
			reject(new Error("Ripgrep failed"));
		});

		child.on("close", (code) => {
			cleanup();
			state.exitCode = code;
			resolve(state);
		});
	});
}

function searchError(state: RipgrepState): Error {
	const last = state.stderr.trim().split("\n").pop() ?? "";
	const reason = last.replace(/^(?:rg|grep):\s*/, "").replace(/^error:\s*/, "");

	return new Error(reason ? `Search failed: ${reason}` : "Search failed");
}

async function buildOutputLines(
	state: RipgrepState,
	context: number,
	options: Omit<MatchBlockOptions, "context">,
): Promise<{ lines: string[]; truncated: boolean }> {
	const outputLines: string[] = [];
	let truncated = false;

	for (const match of state.matches) {
		const useSingleLine = context === 0 && match.lineText !== undefined;

		if (!useSingleLine) {
			const block = await matchBlock(match, { ...options, context });
			outputLines.push(...block.lines);
			truncated = truncated || block.truncated;
			continue;
		}

		const single = singleLineMatch(match, options.searchPath, options.isDirectory);
		outputLines.push(single.line);
		truncated = truncated || single.truncated;
	}

	return { lines: outputLines, truncated };
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
			`matches or ${DEFAULT_MAX_BYTES / BYTES_PER_KB}KB (whichever is hit first). ` +
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
			assertNotAborted(signal);

			const rgPath = await ensureTool("rg");

			assertNotAborted(signal);

			if (!rgPath) {
				throw new Error("Ripgrep missing");
			}

			const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
			const ops = customOps ?? defaultGrepOperations;

			let isDirectory: boolean;
			try {
				isDirectory = await ops.isDirectory(searchPath);
			} catch {
				throw new Error("Path missing");
			}

			assertNotAborted(signal);

			const contextValue = normalizeContext(context);
			const effectiveLimit = normalizeLimit(limit);
			const args = buildGrepArgs({ pattern, searchPath, glob, ignoreCase, literal });
			const state = await collectRipgrep(rgPath, args, effectiveLimit, signal);

			assertNotAborted(signal);

			// Partial matches
			const partial = state.exitCode === RG_ERROR_EXIT && state.matchCount > 0;
			const failed =
				!state.limitReached &&
				state.exitCode !== RG_MATCH_EXIT &&
				state.exitCode !== RG_NO_MATCH_EXIT &&
				!partial;

			if (failed) throw searchError(state);

			if (state.matchCount === 0) return noMatches();

			const output = await buildOutputLines(state, contextValue, {
				searchPath,
				isDirectory,
				ops,
				cache: new Map<string, string[]>(),
			});

			return summarizeMatches({
				lines: output.lines,
				limit: effectiveLimit,
				matchCount: state.matchCount,
				matchLimitReached: state.limitReached,
				linesTruncated: output.truncated,
				searchErrors: partial ? stderrLines(state.stderr) : undefined,
			});
		},
		...grepRenderers,
	};
}

export function createGrepTool(
	cwd: string,
	options?: GrepToolOptions,
): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
