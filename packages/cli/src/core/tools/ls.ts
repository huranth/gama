import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import nodePath from "node:path";
import type { AgentTool } from "@huranth/gama-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { assertNotAborted } from "./abort.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";
import { lsRenderers } from "./ui/ls.ts";

const DEFAULT_LIMIT = 500;

const MIN_LIMIT = 1;

const LIMIT_FACTOR = 2;

const lsSchema = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Directory to list (default: current directory)" }),
	),
	limit: Type.Optional(
		Type.Number({
			description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})`,
		}),
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

type Listing = {
	entries: string[];
	entryLimitReached: boolean;
};

export const lsToolSystemPromptContribution = {
	snippet: "List directory contents",
	guidelines: [],
} as const;

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;

	return Math.max(MIN_LIMIT, Math.floor(limit));
}

async function assertDirectory(dirPath: string, ops: LsOperations): Promise<void> {
	if (!(await ops.exists(dirPath))) {
		throw new Error("Path missing");
	}

	const stat = await ops.stat(dirPath);
	if (!stat.isDirectory()) {
		throw new Error("Not a directory");
	}
}

async function readEntries(dirPath: string, ops: LsOperations): Promise<string[]> {
	try {
		return await ops.readdir(dirPath);
	} catch {
		throw new Error("List failed");
	}
}

function sortEntries(entries: string[]): string[] {
	return [...entries].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

async function formatEntry(fullPath: string, name: string, ops: LsOperations): Promise<string> {
	try {
		const stat = await ops.stat(fullPath);
		if (stat.isDirectory()) return `${name}/`;
	} catch {
		// Keep raw
	}

	return name;
}

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

function buildNotices(listing: Listing, effectiveLimit: number, truncated: boolean): string[] {
	const notices: string[] = [];

	if (listing.entryLimitReached) {
		notices.push(
			`${effectiveLimit} entries limit reached. ` +
				`Use limit=${effectiveLimit * LIMIT_FACTOR} for more`,
		);
	}

	if (truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);

	return notices;
}

function renderListing(listing: Listing, effectiveLimit: number) {
	if (listing.entries.length === 0) {
		return {
			content: [{ type: "text" as const, text: "(empty directory)" }],
			details: undefined,
		};
	}

	const rawOutput = listing.entries.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	const notices = buildNotices(listing, effectiveLimit, truncation.truncated);
	const details: LsToolDetails = {};

	if (listing.entryLimitReached) details.entryLimitReached = effectiveLimit;
	if (truncation.truncated) details.truncation = truncation;

	let output = truncation.content;

	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

	return {
		content: [{ type: "text" as const, text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

function describeListing(): string {
	return (
		"List directory contents. Returns entries sorted alphabetically, " +
		"with '/' suffix for directories. Includes dotfiles. " +
		`Output is truncated to ${DEFAULT_LIMIT} entries or ` +
		`${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`
	);
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;

	return {
		name: "ls",
		label: "ls",
		description: describeListing(),
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			assertNotAborted(signal);

			const dirPath = resolveToCwd(path || ".", ctx?.cwd || cwd);
			const effectiveLimit = normalizeLimit(limit);

			await assertDirectory(dirPath, ops);
			assertNotAborted(signal);

			const entries = sortEntries(await readEntries(dirPath, ops));
			const listing = await collectEntries(dirPath, entries, effectiveLimit, ops);

			assertNotAborted(signal);

			return renderListing(listing, effectiveLimit);
		},
		...lsRenderers,
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
