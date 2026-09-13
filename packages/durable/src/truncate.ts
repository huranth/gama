export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	lastLinePartial: boolean;
	firstLineExceedsLimit: boolean;
	maxLines: number;
	maxBytes: number;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
}

interface RuntimeBuffer {
	byteLength(content: string, encoding: "utf8"): number;
}

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
const nonAsciiPattern = /[^\x00-\x7f]/;

export function utf8ByteLength(content: string): number {
	if (runtimeBuffer) return runtimeBuffer.byteLength(content, "utf8");

	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;

	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const firstLineBytes = utf8ByteLength(lines[0]);
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0);

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	if (truncatedBy !== "bytes") {
		truncatedBy = outputLinesArr.length < totalLines ? "lines" : "bytes";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}
