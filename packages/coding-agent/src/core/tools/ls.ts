import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@huranth/gama-agent-core";
import nodePath from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
import { lsRenderers } from "./ui/ls.ts";

const lsSchema = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Directory to list (default: current directory)" }),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of entries to return (default: 500)" }),
	),
});

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

export interface LsOperations {
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	stat: (
		absolutePath: string,
	) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

export interface LsToolOptions {
	operations?: LsOperations;
}

export const lsToolSystemPromptContribution = {
	snippet: "List directory contents",
	guidelines: [],
} as const;

const DEFAULT_LIMIT = 500;

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	const limitKb = DEFAULT_MAX_BYTES / 1024;
	const description = [
		"List directory contents. Returns entries sorted alphabetically, ",
		"with '/' suffix for directories. Includes dotfiles. ",
		`Output is truncated to ${DEFAULT_LIMIT} entries or `,
		`${limitKb}KB (whichever is hit first).`,
	].join("");
	return {
		name: "ls",
		label: "ls",
		description,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", ctx?.cwd || cwd);
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

						await assertDirectory(dirPath, ops);

						const entries = sortEntries(await readEntries(dirPath, ops));
						const listing = await collectEntries(dirPath, entries, effectiveLimit, ops);

						signal?.removeEventListener("abort", onAbort);
						resolve(buildResult(listing, effectiveLimit));
					} catch (error) {
						signal?.removeEventListener("abort", onAbort);
						reject(error);
					}
				})();
			});
		},
		...lsRenderers,
	};
}

async function assertDirectory(dirPath: string, ops: LsOperations): Promise<void> {
	if (!(await ops.exists(dirPath))) {
		throw new Error(`Could not find ${dirPath}`);
	}

	const stat = await ops.stat(dirPath);
	if (!stat.isDirectory()) {
		throw new Error(`Could not list ${dirPath}, it is not a directory`);
	}
}

async function readEntries(dirPath: string, ops: LsOperations): Promise<string[]> {
	try {
		return await ops.readdir(dirPath);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not list ${dirPath}, ${reason}`);
	}
}

function sortEntries(entries: string[]): string[] {
	return [...entries].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

type Listing = {
	entries: string[];
	entryLimitReached: boolean;
};

async function collectEntries(
	dirPath: string,
	entries: string[],
	limit: number,
	ops: LsOperations,
): Promise<Listing> {
	const results: string[] = [];
	let entryLimitReached = false;

	for (const entry of entries) {
		if (results.length >= limit) {
			entryLimitReached = true;
			break;
		}

		results.push(await formatEntry(nodePath.join(dirPath, entry), entry, ops));
	}

	return { entries: results, entryLimitReached };
}

async function formatEntry(fullPath: string, name: string, ops: LsOperations): Promise<string> {
	try {
		const stat = await ops.stat(fullPath);
		if (stat.isDirectory()) return `${name}/`;
	} catch {
		// Keep unreadable.
	}

	return name;
}

function buildResult(listing: Listing, effectiveLimit: number) {
	if (listing.entries.length === 0) {
		return {
			content: [{ type: "text" as const, text: "(empty directory)" }],
			details: undefined,
		};
	}

	const rawOutput = listing.entries.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const details: LsToolDetails = {};
	const notices: string[] = [];

	if (listing.entryLimitReached) {
		notices.push(
			`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
		);
		details.entryLimitReached = effectiveLimit;
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
