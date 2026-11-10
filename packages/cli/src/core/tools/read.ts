import { constants, createReadStream } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@huranth/gama-agent-core";
import type {
	Api,
	ImageContent,
	Model,
	ModelImageResizeOptions,
	TextContent,
} from "@huranth/gama-ai";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { stripBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { assertNotAborted } from "./abort.ts";
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

const BYTES_PER_KB = 1024;

const MAX_BUFFERED_TEXT_BYTES = 4 * BYTES_PER_KB * BYTES_PER_KB;

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

export function createReadTool(
	cwd: string,
	options?: ReadToolOptions,
): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}

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
			`to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / BYTES_PER_KB}KB ` +
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
		): Promise<ReadOutcome> {
			try {
				const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
				assertNotAborted(signal);

				await assertAccess(absolutePath, ops);
				assertNotAborted(signal);

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
					: await readText(context, offset, limit, signal);

				assertNotAborted(signal);

				return result;
			} catch (error) {
				const code = errorCode(error);

				throw code ? describeReadError(error) : error;
			}
		},
		...readRenderers,
	};
}

function splitLines(text: string): string[] {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	return lines;
}

function errorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	if (typeof error.code !== "string") return undefined;

	return error.code;
}

function describeReadError(error: unknown): Error {
	switch (errorCode(error)) {
		case "ENOENT":
			return new Error("File missing");
		case "EACCES":
		case "EPERM":
			return new Error("Read denied");
		case "EISDIR":
			return new Error("Not a file");
		default:
			return new Error("Read failed");
	}
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) return undefined;

	return "[Current model does not support images. The image will be omitted from this request.]";
}

async function assertAccess(absolutePath: string, ops: ReadOperations): Promise<void> {
	try {
		await ops.access(absolutePath);
	} catch (error) {
		throw describeReadError(error);
	}
}

async function readFileBuffer(context: ReadContext): Promise<Buffer> {
	try {
		return await context.ops.readFile(context.absolutePath);
	} catch (error) {
		throw describeReadError(error);
	}
}

function isBinaryBuffer(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, 8000);
	if (sample.includes(0)) return true;
	const text = sample.toString("utf-8");
	return (text.match(/\uFFFD/g)?.length ?? 0) > 4;
}

function binaryReadOutcome(context: ReadContext): ReadOutcome {
	return {
		content: [
			{
				type: "text",
				text: `Could not read ${context.displayPath}, it looks like a binary file.`,
			},
		],
		details: undefined,
		isError: true,
	};
}

async function readImage(context: ReadContext, mimeType: string): Promise<ReadOutcome> {
	const buffer = await readFileBuffer(context);
	const processed = await processImage(buffer, mimeType, {
		autoResizeImages: context.autoResizeImages,
		resizeOptions: context.resizeOptions,
	});
	const note = getNonVisionImageNote(context.model);

	if (!processed.ok) {
		let text = "Image omitted";

		if (note) text += `\n${note}`;

		return { content: [{ type: "text", text }], details: undefined, isError: true };
	}

	let text = `Read image file [${processed.mimeType}]`;

	if (processed.hints.length > 0) text += `\n${processed.hints.join("\n")}`;
	if (note) text += `\n${note}`;

	context.tracker?.markRead(context.absolutePath);
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
	signal?: AbortSignal,
): Promise<ReadOutcome> {
	if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
		throw new Error("Bad offset");
	}
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
		throw new Error("Bad limit");
	}

	if (context.ops === defaultReadOperations) {
		const stats = await fsStat(context.absolutePath).catch(() => undefined);
		if (stats && stats.size > MAX_BUFFERED_TEXT_BYTES) {
			return readTextStream(context, offset, limit, signal);
		}
	}

	const buffer = await readFileBuffer(context);
	if (isBinaryBuffer(buffer)) return binaryReadOutcome(context);
	const lines = splitLines(stripBom(buffer.toString("utf-8")));
	const startLine = offset === undefined ? 0 : offset - 1;

	if (startLine >= lines.length) {
		throw new Error("Offset too big");
	}

	const endLine = limit === undefined ? lines.length : Math.min(startLine + limit, lines.length);
	const selected = lines.slice(startLine, endLine).join("\n");
	const truncation = truncateHead(selected);
	const output = formatTextOutput({
		truncation,
		totalLines: lines.length,
		firstLine: lines[startLine],
		startLine,
		offset,
		limit,
		displayPath: context.displayPath,
	});

	const complete =
		startLine === 0 &&
		endLine === lines.length &&
		!truncation.truncated &&
		!truncation.firstLineExceedsLimit;
	context.tracker?.markRead(context.absolutePath, { complete });
	return { content: [{ type: "text", text: output.text }], details: output.details };
}

async function readTextStream(
	context: ReadContext,
	offset: number | undefined,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<ReadOutcome> {
	const startLine = offset === undefined ? 0 : offset - 1;
	const stream = createReadStream(context.absolutePath, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	const selected: string[] = [];
	let lineCount = 0;
	let selectedBytes = 0;
	const maxSelectedLines = DEFAULT_MAX_LINES + 1;

	try {
		for await (const raw of lines) {
			assertNotAborted(signal);

			const line = lineCount === 0 ? stripBom(raw) : raw;
			lineCount += 1;

			if (lineCount - 1 < startLine) continue;

			const bytes = Buffer.byteLength(line, "utf-8") + (selected.length > 0 ? 1 : 0);
			selected.push(line);
			selectedBytes += bytes;

			// Early stop
			if (limit !== undefined && selected.length >= limit) break;
			if (selected.length >= maxSelectedLines) break;
			if (selectedBytes > DEFAULT_MAX_BYTES) break;
		}
	} finally {
		lines.close();
		stream.destroy();
	}

	if (selected.some((line) => line.includes("\x00"))) {
		return binaryReadOutcome(context);
	}

	if (lineCount === 0) {
		lineCount = 1;
		selected.push("");
	}

	if (startLine >= lineCount) {
		throw new Error("Offset too big");
	}

	const endLine = limit === undefined ? lineCount : Math.min(startLine + limit, lineCount);
	const truncation = {
		...truncateHead(selected.join("\n")),
		totalLines: Math.max(0, endLine - startLine),
	};
	const output = formatTextOutput({
		truncation,
		// Scanned lines
		totalLines: lineCount,
		firstLine: selected[0] ?? "",
		startLine,
		offset,
		limit,
		displayPath: context.displayPath,
	});

	const complete =
		startLine === 0 &&
		endLine === lineCount &&
		!truncation.truncated &&
		!truncation.firstLineExceedsLimit;
	context.tracker?.markRead(context.absolutePath, { complete });

	return { content: [{ type: "text", text: output.text }], details: output.details };
}

function formatTextOutput(input: {
	truncation: TruncationResult;
	totalLines: number;
	firstLine: string;
	startLine: number;
	offset: number | undefined;
	limit: number | undefined;
	displayPath: string;
}): { text: string; details: ReadToolDetails | undefined } {
	const { truncation, totalLines, firstLine, startLine, limit, displayPath } = input;
	const startLineDisplay = startLine + 1;

	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(firstLine, "utf-8"));

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
				`of ${totalLines}${limitNote}. Use offset=${nextOffset} to continue.]`,
			details: { truncation },
		};
	}

	if (limit !== undefined && startLine + limit < totalLines) {
		const remaining = totalLines - (startLine + limit);
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
