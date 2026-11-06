export { decodeHtmlEntities } from "./entities.ts";

export interface TruncatedText {
	text: string;
	truncated: boolean;
}

const MAX_BLANK_LINES = 2;

const BLANK_RUN = new RegExp(`\\n{${MAX_BLANK_LINES + 1},}`, "g");

const PARAGRAPH_GAP = "\n".repeat(MAX_BLANK_LINES);

const SURROGATE_START = 0xd800;

const HIGH_SURROGATE_END = 0xdbff;

export function normalizeText(text: string): string {
	const lines = text.replace(/\r/g, "").split("\n");
	const cleaned = lines.map(cleanLine).filter((line) => line.length > 0 && !isNoiseLine(line));

	return cleaned.join("\n").replace(BLANK_RUN, PARAGRAPH_GAP).trim();
}

export function truncateText(text: string, maxChars: number): TruncatedText {
	if (text.length <= maxChars) return { text, truncated: false };

	let cut = cutAtLine(text, maxChars);
	if (hasOpenFence(cut)) cut += "\n```\n[code block truncated]";

	const marker = `\n\n[Content truncated - showing ${cut.length} of ${text.length} chars]`;

	return { text: cut + marker, truncated: true };
}

export function truncateParagraphs(text: string, maxChars: number): TruncatedText {
	if (text.length <= maxChars) return { text, truncated: false };

	let boundary = text.lastIndexOf("\n\n", maxChars);
	if (boundary <= 0) boundary = text.lastIndexOf("\n", maxChars);

	let kept = boundary > 0 ? text.slice(0, boundary) : text.slice(0, maxChars);
	kept = trimSurrogate(kept).trimEnd();
	if (hasOpenFence(kept)) kept += "\n```\n[code block truncated]";

	return { text: `${kept}\n\n[Content truncated]`, truncated: true };
}

function cleanLine(line: string): string {
	const isListItem = /^[ \t]+\* /.test(line);
	if (isListItem) {
		const indent = line.match(/^[ \t]+/)?.[0].replace(/\t/g, "  ") ?? "";
		return indent + line.trim().replace(/[ \t\f\v]+/g, " ");
	}

	return line.replace(/[ \t\f\v]+/g, " ").trim();
}

function isNoiseLine(line: string): boolean {
	const trimmed = line.trim();
	const isBadgeHost = /(shields\.io|camo\.githubusercontent\.com|\/badge)/i.test(trimmed);

	if (/^\[?!\[Refer to caption\]/i.test(trimmed)) return true;
	if (/^\{"wt":/.test(trimmed)) return true;
	if (/^(\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/.test(trimmed)) return true;
	if (/^(!\[[^\]]*\]\([^)]*\)\s*)+$/.test(trimmed)) {
		return isBadgeHost || /!\[\]\(/.test(trimmed);
	}

	return /^https?:\/\/\S+$/.test(trimmed) && isBadgeHost;
}

function trimSurrogate(cut: string): string {
	const last = cut.charCodeAt(cut.length - 1);
	const isHigh = last >= SURROGATE_START && last <= HIGH_SURROGATE_END;

	return isHigh ? cut.slice(0, -1) : cut;
}

function cutAtLine(text: string, maxChars: number): string {
	const head = text.slice(0, maxChars);
	const lastBreak = head.lastIndexOf("\n");
	const cut = lastBreak > 0 ? head.slice(0, lastBreak) : head;

	return trimSurrogate(cut.trimEnd());
}

function hasOpenFence(text: string): boolean {
	const fences = text.match(/^ {0,3}```/gm)?.length ?? 0;

	return fences % 2 === 1;
}
