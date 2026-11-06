const DROP_TAGS = [
	"head",
	"title",
	"script",
	"style",
	"svg",
	"canvas",
	"iframe",
	"noscript",
	"nav",
	"header",
	"footer",
	"aside",
	"form",
	"button",
	"select",
];

const RAW_TAGS: readonly string[] = ["script", "style"];

const ORPHAN_CLOSE_PATTERN = new RegExp(`</(?:${DROP_TAGS.join("|")})\\s*>`, "gi");

const READABLE_RATIO = 0.1;

const WIKI_PAGE = /id=["']mw-content-text|class=["'][^"']*\bmw-parser-output\b/i;

const JUNK_CLASS =
	/\b(?:infobox|taxobox|navbox|vertical-navbox|metadata|ambox|sistersitebox|side-box)\b/i;

export function stripTags(html: string, replacement = " "): string {
	const lastClose = html.lastIndexOf(">");
	if (lastClose === -1) return html;

	const body = html.slice(0, lastClose + 1).replace(/<[^>]*>/g, () => replacement);

	return `${body}${html.slice(lastClose + 1)}`;
}

// Tag scanner
function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

function stripOrphanCloses(html: string): string {
	return html.replace(ORPHAN_CLOSE_PATTERN, "\n");
}

function isWordChar(char: string): boolean {
	return /[a-z0-9_]/i.test(char);
}

function isSpace(char: string | undefined): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function looksLikeTag(lower: string, position: number): boolean {
	if (lower[position] !== "<") return false;

	const next = lower[position + 1];

	return next === "!" || next === "/" || /[a-z]/i.test(next);
}

function findOpener(lower: string, tagName: string, from: number): number {
	const open = `<${tagName}`;
	let index = from;

	while ((index = lower.indexOf(open, index)) !== -1) {
		const next = lower[index + open.length];

		if (!next || !isWordChar(next)) return index;

		index += 1;
	}

	return -1;
}

function matchClose(lower: string, position: number, tagName: string): number {
	const close = `</${tagName}`;
	if (!lower.startsWith(close, position)) return -1;

	let index = position + close.length;
	while (isSpace(lower[index])) index += 1;

	return lower[index] === ">" ? index + 1 : -1;
}

function findClose(lower: string, tagName: string, from: number): number {
	const close = `</${tagName}`;
	let index = from;

	while ((index = lower.indexOf(close, index)) !== -1) {
		const end = matchClose(lower, index, tagName);

		if (end !== -1) return end;

		index += 1;
	}

	return -1;
}

// Nested close
function findNestedClose(lower: string, tagName: string, from: number): number {
	let depth = 1;
	let scan = from;

	while (depth > 0) {
		const open = findOpener(lower, tagName, scan);
		const close = findClose(lower, tagName, scan);
		if (close === -1) return -1;

		if (open !== -1 && open < close) {
			depth += 1;
			scan = open + 1;
		} else {
			depth -= 1;
			if (depth === 0) return close;
			scan = close;
		}
	}

	return -1;
}

export function removeElement(
	html: string,
	tagName: string,
	shouldRemove?: (attrs: string) => boolean,
): string {
	const lower = asciiLower(html);
	let result = "";
	let copyFrom = 0;
	let scan = 0;

	for (;;) {
		const open = findOpener(lower, tagName, scan);
		if (open === -1) break;

		const gt = html.indexOf(">", open);
		if (gt === -1) break; // Missing end

		const attrs = html.slice(open + tagName.length + 1, gt);
		if (shouldRemove && !shouldRemove(attrs)) {
			scan = open + 1;
			continue;
		}

		const closeEnd = findNestedClose(lower, tagName, gt + 1);
		if (closeEnd === -1) break; // No close

		result += `${html.slice(copyFrom, open)}\n`;
		copyFrom = closeEnd;
		scan = closeEnd;
	}

	return result + html.slice(copyFrom);
}

function removeLoose(html: string, tagName: string): string {
	const lower = asciiLower(html);
	let result = "";
	let copyFrom = 0;
	let scan = 0;

	for (;;) {
		const open = findOpener(lower, tagName, scan);
		if (open === -1) break;

		const gt = html.indexOf(">", open);
		if (gt === -1) break;

		// Swallow tag
		let stop = gt + 1;
		while (stop < html.length && !looksLikeTag(lower, stop)) stop += 1;

		// Own close
		const closeEnd = matchClose(lower, stop, tagName);
		if (closeEnd !== -1) stop = closeEnd;

		result += `${html.slice(copyFrom, open)}\n`;
		copyFrom = stop;
		scan = stop;
	}

	return result + html.slice(copyFrom);
}

function isUnclosed(html: string, tagName: string): boolean {
	const lower = asciiLower(html);
	let opens = 0;
	let scan = 0;

	// Monotonic cursor
	let gt = lower.indexOf(">");
	for (;;) {
		const open = findOpener(lower, tagName, scan);
		if (open === -1) break;

		const need = open + tagName.length + 1;
		while (gt !== -1 && gt < need) gt = lower.indexOf(">", gt + 1);
		if (gt !== -1) opens += 1;

		scan = open + 1;
	}

	let closes = 0;
	let closeScan = 0;
	for (;;) {
		const closeEnd = findClose(lower, tagName, closeScan);
		if (closeEnd === -1) break;

		closes += 1;
		closeScan = closeEnd;
	}

	return opens > closes;
}

function needsLooseRemoval(html: string, tag: string): boolean {
	if (!RAW_TAGS.includes(tag)) return false;

	return isUnclosed(html, tag);
}

function insideRawText(html: string, position: number): boolean {
	const lower = asciiLower(html.slice(0, position));

	for (const tag of RAW_TAGS) {
		let lastOpen = -1;
		let scan = 0;
		for (;;) {
			const found = findOpener(lower, tag, scan);
			if (found === -1) break;

			lastOpen = found;
			scan = found + 1;
		}

		if (lastOpen !== -1 && findClose(lower, tag, lastOpen) === -1) return true;
	}

	return false;
}

function insideTagAttribute(html: string, position: number): boolean {
	let inTag = false;
	let quote = "";

	for (let index = 0; index < position; index += 1) {
		const char = html[index];

		if (!inTag) {
			if (char === "<") {
				inTag = true;
				quote = "";
			}
			continue;
		}

		if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === ">") {
			inTag = false;
		}
	}

	return inTag;
}

function stripDataMw(html: string): string {
	return html.replace(/\sdata-mw\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

function stripNoise(html: string): string {
	const cleaned = stripDataMw(html)
		.replace(/<!--[\s\S]*?-->/g, "\n")
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "\n")
		.replace(/<!doctype[^>]*>/gi, "\n");

	const unterminated = cleaned.indexOf("<!--");
	const isAttribute = unterminated !== -1 && insideTagAttribute(cleaned, unterminated);
	if (unterminated !== -1 && !isAttribute && !insideRawText(cleaned, unterminated)) {
		// Unclosed comment
		return `${cleaned.slice(0, unterminated)}\n`;
	}

	return cleaned;
}

function dropJunkBlocks(html: string): string {
	if (!WIKI_PAGE.test(html) || !JUNK_CLASS.test(html)) return html;

	let cleaned = html;

	for (const tag of ["table", "div"]) {
		cleaned = removeElement(cleaned, tag, (attrs) => JUNK_CLASS.test(attrs));
	}

	return cleaned;
}

function dropBoilerplateTags(html: string): string {
	let cleaned = dropJunkBlocks(html);

	for (const tag of DROP_TAGS) {
		cleaned = needsLooseRemoval(cleaned, tag)
			? removeLoose(cleaned, tag)
			: removeElement(cleaned, tag);
	}

	return stripOrphanCloses(cleaned);
}

function removeBoilerplateLoose(raw: string): string {
	return dropBoilerplateTags(stripNoise(raw));
}

function guardAgainstUnclosed(raw: string, cleaned: string): string {
	const readable = stripTags(cleaned).length;
	if (readable >= raw.length * READABLE_RATIO) return cleaned;

	return removeBoilerplateLoose(raw);
}

export function removeBoilerplate(html: string): string {
	const cleaned = dropBoilerplateTags(stripNoise(html));

	return guardAgainstUnclosed(html, cleaned);
}
