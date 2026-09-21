import type { AgentTool } from "@huranth/gama-agent-core";
import type {
	Api,
	ImageContent,
	Model,
	ModelImageResizeOptions,
	TextContent,
} from "@huranth/gama-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { stripBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "./truncate.ts";
import { readRenderers } from "./ui/read.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(
		Type.Number({ description: "Line number to start reading from (1-indexed)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export interface ReadOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

export interface ReadToolOptions {
	autoResizeImages?: boolean;
	resizeOptions?: ModelImageResizeOptions;
	operations?: ReadOperations;
	tracker?: FileReadTracker;
}

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

type ReadContext = {
	absolutePath: string;
	displayPath: string;
	ops: ReadOperations;
	tracker: FileReadTracker | undefined;
	autoResizeImages: boolean;
	resizeOptions: ModelImageResizeOptions | undefined;
	model: Model<Api> | undefined;
};

type ReadOutcome = {
	content: (TextContent | ImageContent)[];
	details: ReadToolDetails | undefined;
	isError?: true;
};

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	const tracker = options?.tracker;
	return {
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, " +
			"webp, bmp). Images are sent as attachments. For text files, output is truncated " +
			`to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB ` +
			"(whichever is hit first). Use offset/limit for large files. " +
			"When you need the full file, continue with offset until complete.",
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise<{
				content: (TextContent | ImageContent)[];
				details: ReadToolDetails | undefined;
			}>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let aborted = false;
				const onAbort = () => {
					aborted = true;
					reject(new Error("Operation aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
						if (aborted) return;

						await assertAccess(absolutePath, path, ops);
						if (aborted) return;

						const model = ctx?.model;
						const resizeOptions = model?.inputLimits?.images?.resize ?? fallbackResizeOptions;
						const context: ReadContext = {
							absolutePath,
							displayPath: path,
							ops,
							tracker,
							autoResizeImages,
							resizeOptions,
							model,
						};

						const mimeType = ops.detectImageMimeType
							? await ops.detectImageMimeType(absolutePath)
							: undefined;
						const result = mimeType
							? await readImage(context, mimeType)
							: await readText(context, offset, limit);

						if (aborted) return;

						signal?.removeEventListener("abort", onAbort);
						resolve(result);
					} catch (error) {
						signal?.removeEventListener("abort", onAbort);
						if (aborted) return;

						const code =
							error && typeof error === "object" && "code" in error ? error.code : undefined;
						reject(code ? describeReadError(path, error) : error);
					}
				})();
			});
		},
		...readRenderers,
	};
}

export function createReadTool(
	cwd: string,
	options?: ReadToolOptions,
): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}

async function assertAccess(
	absolutePath: string,
	displayPath: string,
	ops: ReadOperations,
): Promise<void> {
	try {
		await ops.access(absolutePath);
	} catch (error) {
		throw describeReadError(displayPath, error);
	}
}

async function readFileBuffer(context: ReadContext): Promise<Buffer> {
	try {
		return await context.ops.readFile(context.absolutePath);
	} catch (error) {
		throw describeReadError(context.displayPath, error);
	}
}

async function readImage(context: ReadContext, mimeType: string): Promise<ReadOutcome> {
	const buffer = await readFileBuffer(context);
	context.tracker?.markRead(context.absolutePath);

	const processed = await processImage(buffer, mimeType, {
		autoResizeImages: context.autoResizeImages,
		resizeOptions: context.resizeOptions,
	});
	const note = getNonVisionImageNote(context.model);

	if (!processed.ok) {
		let text = `Could not read the image ${context.displayPath}, ${processed.message}`;

		if (note) text += `\n${note}`;

		return { content: [{ type: "text", text }], details: undefined, isError: true };
	}

	let text = `Read image file [${processed.mimeType}]`;

	if (processed.hints.length > 0) text += `\n${processed.hints.join("\n")}`;
	if (note) text += `\n${note}`;

	return {
		content: [
			{ type: "text", text },
			{ type: "image", data: processed.data, mimeType: processed.mimeType },
		],
		details: undefined,
	};
}

async function readText(
	context: ReadContext,
	offset: number | undefined,
	limit: number | undefined,
): Promise<ReadOutcome> {
	if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
		throw new Error(`Offset must be a positive line number, got ${offset}`);
	}
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
		throw new Error(`Limit must be a positive line count, got ${limit}`);
	}

	const buffer = await readFileBuffer(context);
	context.tracker?.markRead(context.absolutePath);

	const lines = splitLines(stripBom(buffer.toString("utf-8")));
	const startLine = offset === undefined ? 0 : offset - 1;

	if (startLine >= lines.length) {
		throw new Error(`Offset ${offset} is past the end of the file, it has ${lines.length} lines`);
	}

	const endLine = limit === undefined ? lines.length : Math.min(startLine + limit, lines.length);
	const selected = lines.slice(startLine, endLine).join("\n");
	const truncation = truncateHead(selected);
	const output = formatTextOutput({
		truncation,
		lines,
		startLine,
		offset,
		limit,
		displayPath: context.displayPath,
	});

	return { content: [{ type: "text", text: output.text }], details: output.details };
}

function splitLines(text: string): string[] {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	return lines;
}

function formatTextOutput(input: {
	truncation: TruncationResult;
	lines: string[];
	startLine: number;
	offset: number | undefined;
	limit: number | undefined;
	displayPath: string;
}): { text: string; details: ReadToolDetails | undefined } {
	const { truncation, lines, startLine, limit, displayPath } = input;
	const startLineDisplay = startLine + 1;

	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(lines[startLine], "utf-8"));

		return {
			text:
				`[Line ${startLineDisplay} is ${firstLineSize}, ` +
				`exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. ` +
				`Use bash: sed -n '${startLineDisplay}p' ${displayPath} ` +
				`| head -c ${DEFAULT_MAX_BYTES}]`,
			details: { truncation },
		};
	}

	if (truncation.truncated) {
		const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		const limitNote =
			truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;

		return {
			text:
				`${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} ` +
				`of ${lines.length}${limitNote}. Use offset=${nextOffset} to continue.]`,
			details: { truncation },
		};
	}

	if (limit !== undefined && startLine + limit < lines.length) {
		const remaining = lines.length - (startLine + limit);
		const nextOffset = startLine + limit + 1;

		return {
			text:
				`${truncation.content}\n\n[${remaining} more lines in file. ` +
				`Use offset=${nextOffset} to continue.]`,
			details: undefined,
		};
	}

	return { text: truncation.content, details: undefined };
}

function describeReadError(path: string, error: unknown): Error {
	const code = error instanceof Error && "code" in error ? error.code : undefined;

	if (code === "ENOENT") return new Error(`Could not read ${path}, the file does not exist`);
	if (code === "EACCES" || code === "EPERM")
		return new Error(`Could not read ${path}, permission denied`);
	if (code === "EISDIR") return new Error(`Could not read ${path}, it is a directory, use ls`);

	const reason = error instanceof Error ? error.message : String(error);

	return new Error(`Could not read ${path}, ${reason}`);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) return undefined;

	return "[Current model does not support images. The image will be omitted from this request.]";
}
