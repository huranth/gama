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

export interface MiddleTruncationResult {
	content: string;
	truncated: boolean;
	removedChars: number;
	totalBytes: number;
	totalLines: number;
}

export const DEFAULT_MAX_LINES = 2000;

export const DEFAULT_MAX_BYTES = 50 * 1024;

export const GREP_MAX_LINE_LENGTH = 500;

const bytesPerKb = 1024;

const mbBytes = 1024 * 1024;

const continuationMask = 0xc0;

const continuationBits = 0x80;

const truncatedSuffix = "... [truncated]";

const loneSurrogate = /[\uD800-\uDBFF]$/;

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];

	const lines = content.split("\n");

	if (content.endsWith("\n")) lines.pop();

	return lines;
}

export function formatSize(bytes: number): string {
	if (bytes < bytesPerKb) return `${bytes}B`;
	if (bytes < mbBytes) return `${(bytes / bytesPerKb).toFixed(1)}KB`;

	return `${(bytes / mbBytes).toFixed(1)}MB`;
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) return str;

	let start = buf.length - maxBytes;

	while (start < buf.length && (buf[start] & continuationMask) === continuationBits) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };

	if (maxChars <= truncatedSuffix.length) {
		return { text: truncatedSuffix.slice(0, maxChars), wasTruncated: true };
	}

	let text = line.slice(0, maxChars - truncatedSuffix.length);

	// Surrogate safe
	if (loneSurrogate.test(text)) text = text.slice(0, -1);

	return { text: `${text}${truncatedSuffix}`, wasTruncated: true };
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
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

	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");

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

	const kept: string[] = [];
	let keptBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);

		if (keptBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		kept.push(line);
		keptBytes += lineBytes;
	}

	if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";

	const outputContent = kept.join("\n");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: kept.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
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

	const kept: string[] = [];
	let keptBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);

		if (keptBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";

			if (kept.length === 0) {
				const partial = truncateStringToBytesFromEnd(line, maxBytes);
				kept.unshift(partial);
				keptBytes = Buffer.byteLength(partial, "utf-8");
				lastLinePartial = true;
			}

			break;
		}

		kept.unshift(line);
		keptBytes += lineBytes;
	}

	if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";

	const outputContent = kept.join("\n");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: kept.length,
		outputBytes: Buffer.byteLength(outputContent, "utf-8"),
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

export function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult {
	const buf = Buffer.from(content, "utf-8");
	const totalLines = splitLinesForCounting(content).length;

	if (buf.length <= maxBytes) {
		return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
	}

	const isBoundary = (index: number) =>
		index >= buf.length || (buf[index] & continuationMask) !== continuationBits;

	const headBudget = Math.floor(maxBytes / 2);

	let headEnd = headBudget;
	while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;

	let tailStart = buf.length - (maxBytes - headBudget);
	while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;

	const head = buf.subarray(0, headEnd).toString("utf-8");
	const tail = buf.subarray(tailStart).toString("utf-8");
	const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;

	return {
		content: `${head}...${removedChars} chars truncated...${tail}`,
		truncated: true,
		removedChars,
		totalBytes: buf.length,
		totalLines,
	};
}
