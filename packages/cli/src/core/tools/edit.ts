import type { AgentTool } from "@huranth/gama-agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { writeFileAtomicSync } from "../../utils/atomic-write.ts";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { assertNotAborted } from "./abort.ts";
import {
	applyEditsToNormalizedContent,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	isUniformCrlf,
	normalizeToLF,
	restoreCrlf,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { type EditRenderState, editRenderers } from "./ui/edit.ts";

const textEncoding = "utf-8";

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
}

export interface EditOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
}

export interface EditToolOptions {
	operations?: EditOperations;
	tracker?: FileReadTracker;
}

type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

type SingleEditInput = { oldText: string; newText: string };

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original " +
				"file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original " +
				"file, not incrementally. Do not include overlapping or nested edits. If two " +
				"changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet:
		"Make precise file edits with exact text replacement, " +
		"including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"Read a file before editing it; edits to files you have not read are rejected",
		"When changing multiple separate locations in one file, use one edit call " +
			"with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier " +
			"edits are applied. Do not emit overlapping or nested edits. " +
			"Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. " +
			"Do not pad with large unchanged regions.",
	],
} as const;

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: async (path, content) => writeFileAtomicSync(path, content),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);

			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;

	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });

	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("No edits");
	}

	return { path: input.path, edits: input.edits };
}

function describeEditError(error: unknown): Error {
	const code = error instanceof Error && "code" in error ? error.code : undefined;

	if (code === "ENOENT") return new Error("File missing");

	if (code === "EACCES" || code === "EPERM") return new Error("Edit denied");

	if (code === "EISDIR") return new Error("Not a file");

	if (code) return new Error("Open failed");

	return new Error("Edit failed");
}

function decodeUtf8(buffer: Buffer): string {
	try {
		// Keep BOM
		const options = { fatal: true, ignoreBOM: true };
		return new TextDecoder(textEncoding, options).decode(buffer);
	} catch {
		throw new Error("Bad encoding");
	}
}

function editedMessage(count: number, path: string): string {
	const blockWord = count === 1 ? "block" : "blocks";
	return `Edited ${count} ${blockWord} in ${path}`;
}

export function createEditTool(
	cwd: string,
	options?: EditToolOptions,
): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

// Tool wiring
export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const tracker = options?.tracker;

	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must " +
			"match a unique, non-overlapping region of the original file. If two changes " +
			"affect the same block or nearby lines, merge them into one edit instead of " +
			"emitting overlapping edits. Do not include large unchanged regions just to " +
			"connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(
			_toolCallId,
			input: EditToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);

			return withFileMutationQueue(absolutePath, async () => {
				assertNotAborted(signal);

				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					assertNotAborted(signal);
					throw describeEditError(error);
				}

				assertNotAborted(signal);
				tracker?.assertRead(absolutePath);
				tracker?.assertUnchanged(absolutePath);

				let buffer: Buffer;

				try {
					buffer = await ops.readFile(absolutePath);
				} catch (error) {
					assertNotAborted(signal);
					throw describeEditError(error);
				}

				const rawContent = decodeUtf8(buffer);
				assertNotAborted(signal);

				const { bom, text: content } = splitBom(rawContent);
				const crlf = isUniformCrlf(content);
				const normalizedContent = crlf ? normalizeToLF(content) : content;

				const { baseContent, newContent } = applyEditsToNormalizedContent(
					normalizedContent,
					edits,
				);
				assertNotAborted(signal);

				const finalContent = bom + (crlf ? restoreCrlf(newContent) : newContent);

				// Re-check
				tracker?.assertUnchanged(absolutePath);
				assertNotAborted(signal);

				try {
					await ops.writeFile(absolutePath, finalContent);
				} catch (error) {
					throw describeEditError(error);
				}

				tracker?.markWritten(absolutePath);

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);

				return {
					content: [{ type: "text", text: editedMessage(edits.length, path) }],
					details: {
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
					},
				};
			});
		},
		...editRenderers,
	};
}
