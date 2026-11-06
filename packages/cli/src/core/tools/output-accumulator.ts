import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTempFiles } from "../../utils/temp-cleanup.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

export interface FullOutput {
	content: string;
	truncated: boolean;
}

const TEMP_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

export class OutputAccumulator {
	// Config
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxTailBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	// Buffers
	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;

	// Counters
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	// Temp file
	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileError: Error | undefined;
	private tempFileFailed = false;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxTailBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "gama-output";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Output closed");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileFailed) {
			if (data.length > 0) this.rawChunks.push(data);
			return;
		}

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);

			return;
		}

		if (data.length > 0) this.rawChunks.push(data);
	}

	finish(): void {
		if (this.finished) return;

		this.finished = true;
		this.appendDecodedText(this.decoder.decode());

		if (this.shouldUseTempFile()) this.ensureTempFile();
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.isTruncated();
		const truncatedBy = truncated ? this.truncatedReason(tailTruncation) : null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFileError ? undefined : this.tempFilePath,
		};
	}

	async closeTempFile(): Promise<void> {
		const stream = this.tempFileStream;
		if (!stream) return;

		this.tempFileStream = undefined;
		await new Promise<void>((resolve) => {
			const onError = () => {
				stream.off("finish", onFinish);
				resolve();
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!this.tempFilePath) {
			return {
				content: new TextDecoder().decode(Buffer.concat(this.rawChunks)),
				truncated: this.isTruncated(),
			};
		}

		if (this.tempFileError) return this.inMemoryFullOutput();

		let file: FileHandle;
		try {
			file = await open(this.tempFilePath, "r");
		} catch {
			return this.inMemoryFullOutput();
		}

		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}

			return await this.readHeadAndTail(file, size, maxBytes);
		} finally {
			await file.close();
		}
	}

	private async readHeadAndTail(
		file: FileHandle,
		size: number,
		maxBytes: number,
	): Promise<FullOutput> {
		const headBytes = Math.floor(maxBytes / 2);
		const tailBytes = maxBytes - headBytes;
		const head = Buffer.alloc(headBytes);
		const tail = Buffer.alloc(tailBytes);
		const headRead = (await file.read(head, 0, headBytes, 0)).bytesRead;
		const tailRead = (await file.read(tail, 0, tailBytes, size - tailBytes)).bytesRead;
		const headEnd = completeUtf8End(head, headRead);
		const headText = new TextDecoder().decode(head.subarray(0, headEnd));

		let tailStart = 0;
		while (tailStart < tailRead && (tail[tailStart] & 0xc0) === 0x80) {
			tailStart += 1;
		}

		const tailText = new TextDecoder().decode(tail.subarray(tailStart, tailRead));
		const omitted = size - tailBytes + tailStart - headEnd;

		return {
			content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`,
			truncated: true,
		};
	}

	private inMemoryFullOutput(): FullOutput {
		return {
			content: this.getSnapshotText(),
			truncated: this.isTruncated(),
		};
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) return;

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;

		// Trim tail
		if (this.tailBytes > this.maxTailBytes * 2) this.trimTail();

		this.countLines(text, bytes);
	}

	// Line counters
	private countLines(text: string, bytes: number): void {
		const parts = text.split("\n");

		if (parts.length === 1) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += parts.length - 1;

			const tail = parts[parts.length - 1] ?? "";
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}

		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private isTruncated(): boolean {
		return this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
	}

	private truncatedReason(tailTruncation: TruncationResult): "bytes" | "lines" {
		if (tailTruncation.truncatedBy) return tailTruncation.truncatedBy;

		return this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines";
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxTailBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxTailBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary =
			start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return this.isTruncated() || this.totalRawBytes > this.maxBytes;
	}

	private ensureTempFile(): void {
		if (this.tempFilePath || this.tempFileFailed) return;

		pruneTempFiles({
			prefix: `${this.tempFilePrefix}-`,
			maxAgeMs: TEMP_FILE_MAX_AGE_MS,
			isTarget: (name) => name.endsWith(".log"),
		});

		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);

		const stream = createWriteStream(this.tempFilePath, { mode: 0o600 });
		stream.on("error", (error) => {
			this.tempFileError = error;
			this.tempFileFailed = true;
			this.tempFilePath = undefined;
			this.rawChunks = this.tailText ? [Buffer.from(this.tailText, "utf8")] : [];

			if (this.tempFileStream === stream) this.tempFileStream = undefined;
		});

		this.tempFileStream = stream;

		// Replay chunks
		for (const chunk of this.rawChunks) stream.write(chunk);

		this.rawChunks = [];
	}
}

// Bounds
function utf8SequenceLength(lead: number): number {
	if (lead >= 0xf0) return 4;
	if (lead >= 0xe0) return 3;
	if (lead >= 0xc0) return 2;
	return 1;
}

function completeUtf8End(buffer: Buffer, length: number): number {
	let end = length;
	while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80) end--;
	if (end === 0) return 0;

	const lead = buffer[end - 1];
	const size = utf8SequenceLength(lead);
	return end - 1 + size <= length ? length : end - 1;
}
