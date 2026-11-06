import { removeBoilerplate, stripTags } from "./boilerplate.ts";
import { decodeCodeEntities, decodeHtmlEntities } from "./entities.ts";
import { normalizeText, truncateText } from "./text.ts";

export interface ExtractedContent {
	title?: string;
	description?: string;
	text: string;
	truncated: boolean;
}

const MIN_CANDIDATE_TEXT = 30;

const ARTICLE_BONUS = 1.3;

const SECTION_BONUS = 1.2;

const MAX_HEADING = 6;

const LIST_INDENT = "  ";

const LIST_ROOT = 1;

const HINT_PATTERN =
	/(?:class|id|role)\s*=\s*["'][^"']*\b(?:article|main|content|post)\b/i;

const ARTICLE_BODY_PATTERN = /itemprop\s*=\s*["']articleBody/i;

interface TagToken {
	start: number;
	end: number;
	close: boolean;
	tag: string;
	attrs: string;
	selfClosing: boolean;
}

function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(char: string | undefined): boolean {
	if (!char) return false;
	const code = char.charCodeAt(0);
	return isLetter(code) || (code >= 48 && code <= 57) || char === "_" || char === "-";
}

// Tag scan
function readTag(html: string, start: number): TagToken | null | undefined {
	let at = start + 1;
	const close = html[at] === "/";
	if (close) at += 1;

	const nameStart = at;
	if (!isLetter(html.charCodeAt(at))) return undefined;
	while (isNameChar(html[at])) at += 1;

	const tag = html.slice(nameStart, at).toLowerCase();
	let end = at;
	let quote = "";

	while (end < html.length) {
		const char = html[end];
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === ">") {
			break;
		}
		end += 1;
	}

	if (end >= html.length) return null;

	const selfClosing = html[end - 1] === "/";
	const attrs = html.slice(at, selfClosing ? end - 1 : end);

	return { start, end: end + 1, close, tag, attrs, selfClosing };
}

function scanTags(html: string): TagToken[] {
	const tokens: TagToken[] = [];
	let at = 0;

	while (at < html.length) {
		const start = html.indexOf("<", at);
		if (start === -1) break;

		const token = readTag(html, start);
		if (token === null) break;
		if (token) {
			tokens.push(token);
			at = token.end;
		} else {
			at = start + 1;
		}
	}

	return tokens;
}

const ATTR_PATTERNS = new Map<string, RegExp>();

const CODE_PLACEHOLDER = "\u0000";

const CODE_SLOT = new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, "g");

const HEADING_OR_LIST = new RegExp(
	`<h([1-${MAX_HEADING}])\\b[^>]*>|<(\\/?)(ul|ol|li)\\b[^>]*>`,
	"gi",
);

const BLOCK_ENDS = new RegExp(
	`</(p|div|section|article|main|aside|li|tr|td|th|h[1-${MAX_HEADING}]|blockquote|pre)>`,
	"gi",
);

const BLOCK_STARTS = /<(tr|blockquote)\b[^>]*>/gi;

const BREAK_TAG = /<br\s*\/?>/gi;

const CELL_SPLIT = /<\/t[dh]>\s*<t[dh][^>]*>/gi;

const DEAD_LINK_PREFIXES = ["javascript:", "#"];

const VOID_TAGS = new Set([
	"br",
	"hr",
	"img",
	"input",
	"meta",
	"link",
	"source",
	"wbr",
	"col",
	"area",
	"base",
	"embed",
	"track",
	"param",
]);

interface Block {
	tag: string;
	attrs: string;
	html: string;
}

interface ElementScore {
	textLength: number;
	linkLength: number;
}

interface ScoredBody extends ElementScore {
	entry: Block;
}

function isRoot(tag: string): boolean {
	return tag === "article" || tag === "main";
}

function isLinkable(url: string): boolean {
	if (!url) return false;

	return !DEAD_LINK_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function inlineText(html: string): string {
	return stripTags(html).replace(/\s+/g, " ").trim();
}

function linkTextLength(html: string): number {
	let total = 0;
	for (const match of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
		total += stripTags(match[1]).length;
	}

	return total;
}

function extractTitle(html: string): string | undefined {
	const raw = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	if (raw === undefined) return undefined;

	const value = normalizeText(decodeHtmlEntities(stripTags(raw)));
	return value || undefined;
}

function extractMetaContent(html: string, name: string): string | undefined {
	const wanted = name.toLowerCase();

	for (const token of scanTags(html)) {
		if (token.close || token.tag !== "meta") continue;

		const keys = [
			extractAttr(token.attrs, "name"),
			extractAttr(token.attrs, "property"),
		];
		if (!keys.some((key) => key.toLowerCase() === wanted)) continue;

		const raw = extractAttr(token.attrs, "content");
		const value = raw ? normalizeText(decodeHtmlEntities(raw)) : "";
		if (value) return value;
	}

	return undefined;
}

function extractAttr(attrs: string, name: string): string {
	let pattern = ATTR_PATTERNS.get(name);
	if (!pattern) {
		pattern = attrPattern(name);
		ATTR_PATTERNS.set(name, pattern);
	}

	const match = attrs.match(pattern);
	return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function attrPattern(name: string): RegExp {
	return new RegExp(
		`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
		"i",
	);
}

function convertBlocks(html: string): string {
	return html
		.replace(BREAK_TAG, "\n")
		.replace(CELL_SPLIT, " | ")
		.replace(BLOCK_ENDS, "\n")
		.replace(BLOCK_STARTS, "\n");
}

function convertImages(html: string): string {
	return html.replace(/<img\b[^>]*>/gi, (tag) => {
		const alt = extractAttr(tag, "alt");
		const src = extractAttr(tag, "src");

		if (!alt || !src) return "";

		return `![${alt}](${src})`;
	});
}

function convertLinks(html: string, allowUrls: boolean): string {
	const seen = new Set<string>();

	return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, inner) => {
		const text = inlineText(inner);
		if (!text) return "";

		const url = extractAttr(attrs, "href");
		if (!allowUrls || !isLinkable(url)) return text;
		if (seen.has(url)) return text;

		seen.add(url);
		return `[${text}](${url})`;
	});
}

function convertHeadingsAndLists(html: string): string {
	let depth = 0;

	return html.replace(HEADING_OR_LIST, (_, heading: string, close, name) => {
		if (heading) return `\n${"#".repeat(Number(heading))} `;

		if (name.toLowerCase() === "li") {
			if (close === "/") return "\n";

			const indent = LIST_INDENT.repeat(Math.max(depth - LIST_ROOT, 0));
			return `\n${indent}* `;
		}

		depth = Math.max(depth + (close === "/" ? -1 : 1), 0);
		return "\n";
	});
}

function isCandidate(tag: string, attrs: string): boolean {
	if (isRoot(tag)) return true;
	if (tag !== "div" && tag !== "section") return false;

	return HINT_PATTERN.test(attrs) || ARTICLE_BODY_PATTERN.test(attrs);
}

function scoreCandidate(tag: string, metric: ElementScore): number | undefined {
	const length = metric.textLength;
	if (length < MIN_CANDIDATE_TEXT) return undefined;

	const linkDensity = metric.linkLength / length;
	const bonus = isRoot(tag) ? ARTICLE_BONUS : SECTION_BONUS;

	return length * bonus * (1 - linkDensity);
}

function measureBody(entry: Block): ScoredBody {
	return {
		entry,
		textLength: stripTags(entry.html).length,
		linkLength: linkTextLength(entry.html),
	};
}

function largestOf(metrics: ScoredBody[], tag: string): Block | undefined {
	let best: ScoredBody | undefined;
	for (const metric of metrics) {
		if (metric.entry.tag !== tag) continue;
		if (scoreCandidate(tag, metric) === undefined) continue;

		if (!best || metric.textLength > best.textLength) best = metric;
	}

	return best?.entry;
}

function pickCandidate(html: string): string {
	const bodies = collectBodies(html, isCandidate);
	const metrics = bodies.map(measureBody);

	const article = largestOf(metrics, "article");
	if (article) return article.html;

	const main = largestOf(metrics, "main");
	if (main) return main.html;

	let best: { html: string; score: number } | undefined;
	for (const metric of metrics) {
		const score = scoreCandidate(metric.entry.tag, metric);
		if (score === undefined) continue;

		if (!best || score > best.score) {
			best = { html: metric.entry.html, score };
		}
	}

	return best?.html ?? html;
}

function collectBodies(
	html: string,
	isWanted: (tag: string, attrs: string) => boolean,
): Block[] {
	const bodies: Block[] = [];
	const stack: { tag: string; attrs: string; start: number }[] = [];

	for (const token of scanTags(html)) {
		const tag = token.tag;
		if (token.selfClosing || VOID_TAGS.has(tag)) continue;

		if (!token.close) {
			stack.push({ tag, attrs: token.attrs, start: token.end });
			continue;
		}

		const top = stack[stack.length - 1];
		if (top?.tag !== tag) continue;
		stack.pop();

		if (!isWanted(tag, top.attrs)) continue;
		bodies.push({
			tag,
			attrs: top.attrs,
			html: html.slice(top.start, token.start),
		});
	}

	return bodies;
}

function codeLanguage(inner: string): string {
	const tag = inner.match(/<code\b[^>]*>/i)?.[0] ?? "";
	const classes = extractAttr(tag, "class");
	const match = classes?.match(/(?:language|lang|highlight)[-:](\S+)/i);

	return match?.[1] ?? "";
}

function renderCodeBlock(inner: string): string {
	const language = codeLanguage(inner);
	const raw = inner
		.replace(/^\s*<code\b[^>]*>/i, "")
		.replace(/<\/code>\s*$/i, "");

	const code = decodeCodeEntities(stripTags(raw, "")).replace(/^\s+|\s+$/g, "");

	return `\`\`\`${language}\n${code}\n\`\`\``;
}

function convertInlineCode(html: string, blocks: string[]): string {
	return html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => {
		const text = decodeCodeEntities(stripTags(inner, "")).trim();
		if (!text) return "";

		blocks.push(`\`${text}\``);
		return `${CODE_PLACEHOLDER}${blocks.length - 1}${CODE_PLACEHOLDER}`;
	});
}

function extractCodeBlocks(html: string, blocks: string[]): { body: string } {
	const body = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
		blocks.push(renderCodeBlock(inner));
		return `\n${CODE_PLACEHOLDER}${blocks.length - 1}${CODE_PLACEHOLDER}\n`;
	});

	return { body };
}

function restoreCodeBlocks(text: string, blocks: string[]): string {
	return text.replace(CODE_SLOT, (_, index: string) => blocks[Number(index)] ?? "");
}

function renderMarkdown(html: string): string {
	const blocks: string[] = [];
	const { body } = extractCodeBlocks(html, blocks);

	let out = convertInlineCode(body, blocks);
	out = convertImages(out);
	out = convertLinks(out, true);
	out = convertHeadingsAndLists(out);
	out = convertBlocks(out);
	out = normalizeText(decodeHtmlEntities(stripTags(out)));

	return restoreCodeBlocks(out, blocks);
}

function convertToMarkdown(html: string): string {
	const cleaned = removeBoilerplate(html);
	const chosen = pickCandidate(cleaned);

	return renderMarkdown(chosen);
}

function tryMarkdown(html: string): string {
	try {
		return convertToMarkdown(html);
	} catch {
		return "";
	}
}

export function extractReadableHtml(
	html: string,
	maxChars: number,
): ExtractedContent {
	const title = extractTitle(html);
	const description =
		extractMetaContent(html, "description") ??
		extractMetaContent(html, "og:description");

	let text = tryMarkdown(html);

	// Plain fallback
	if (!text) {
		text = normalizeText(
			decodeHtmlEntities(stripTags(removeBoilerplate(html))),
		);
	}

	const cut = truncateText(text, maxChars);
	if (!cut.text) throw new Error("No text");

	return {
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		text: cut.text,
		truncated: cut.truncated,
	};
}
