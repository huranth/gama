import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { pruneTempFiles } from "../utils/temp-cleanup.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

const TEMP_FILE_ID_BYTES = 8;

const TEMP_FILE_MODE = 0o600;

const TEMP_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const OUTPUT_WINDOW_MULTIPLIER = 2;

export interface BashExecutorOptions {
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

function cleanText(text: string): string {
	return text.replace(/\r/g, "");
}

function cleanChunk(text: string): string {
	return cleanText(sanitizeBinaryOutput(stripAnsi(text)));
}

async function closeStream(stream: WriteStream): Promise<void> {
	stream.end();

	try {
		await finished(stream);
	} catch {
		// Ignore errors
	}
}

// Output window
function createOutputSink(onChunk: ((chunk: string) => void) | undefined) {
	const chunks: string[] = [];
	const maxWindowBytes = DEFAULT_MAX_BYTES * OUTPUT_WINDOW_MULTIPLIER;
	const decoder = new TextDecoder();
	let windowBytes = 0;
	let totalBytes = 0;
	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;

	function openTempFile(): void {
		if (tempFilePath) return;

		pruneTempFiles({
			prefix: "gama-bash-",
			maxAgeMs: TEMP_FILE_MAX_AGE_MS,
			isTarget: (name) => name.endsWith(".log"),
		});

		const id = randomBytes(TEMP_FILE_ID_BYTES).toString("hex");
		tempFilePath = join(tmpdir(), `gama-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath, { mode: TEMP_FILE_MODE });
		tempFileStream.on("error", () => {
			tempFileStream = undefined;
			tempFilePath = undefined;
		});

		for (const chunk of chunks) tempFileStream.write(chunk);
	}

	function trimWindow(): void {
		while (windowBytes > maxWindowBytes && chunks.length > 1) {
			const removed = chunks.shift() ?? "";

			windowBytes -= removed.length;
		}
	}

	function push(text: string): void {
		if (text.length === 0) return;

		if (tempFileStream) tempFileStream.write(text);

		chunks.push(text);
		windowBytes += text.length;
		trimWindow();

		if (onChunk) onChunk(text);
	}

	function onData(data: Buffer): void {
		totalBytes += data.length;

		const text = cleanChunk(decoder.decode(data, { stream: true }));

		if (totalBytes > DEFAULT_MAX_BYTES) openTempFile();

		push(text);
	}

	async function finish(): Promise<{
		output: string;
		truncated: boolean;
		fullOutputPath: string | undefined;
	}> {
		// Flush tail
		push(cleanChunk(decoder.decode()));

		const fullOutput = chunks.join("");
		const truncation = truncateTail(fullOutput);

		if (truncation.truncated) openTempFile();
		if (tempFileStream) await closeStream(tempFileStream);

		return {
			output: truncation.truncated ? truncation.content : fullOutput,
			truncated: truncation.truncated,
			fullOutputPath: tempFilePath,
		};
	}

	async function close(): Promise<void> {
		if (!tempFileStream) return;

		await closeStream(tempFileStream);
	}

	return { onData, finish, close };
}

export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const sink = createOutputSink(options?.onChunk);

	try {
		const result = await operations.exec(command, cwd, {
			onData: sink.onData,
			signal: options?.signal,
		});

		const cancelled = options?.signal?.aborted ?? false;
		const exitCode = cancelled ? undefined : (result.exitCode ?? undefined);
		const output = await sink.finish();

		return { ...output, exitCode, cancelled };
	} catch (error) {
		if (options?.signal?.aborted) {
			const output = await sink.finish();

			return { ...output, exitCode: undefined, cancelled: true };
		}

		await sink.close();

		throw error;
	}
}
