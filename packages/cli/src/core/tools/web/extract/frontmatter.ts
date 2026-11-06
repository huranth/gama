import { decodeHtmlEntities } from "./entities.ts";
import { normalizeText } from "./text.ts";

export interface FrontmatterDoc {
	title?: string;
	description?: string;
	text: string;
}

// Field name
type Field = "title" | "description";

export function extractMarkdownFrontmatter(body: string): FrontmatterDoc {
	const match = body.match(FRONTMATTER_PATTERN);
	if (!match) return { text: normalizeText(decodeHtmlEntities(body)) };

	const frontmatter = match[1]!;

	return {
		title: value(frontmatter, "title") || undefined,
		description: value(frontmatter, "description") || undefined,
		text: normalizeText(decodeHtmlEntities(body.slice(match[0].length))),
	};
}

// Block fence
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// Escape map
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	'"': '"',
	"\\": "\\",
};

// Hex radix
const HEX_RADIX = 16;

// Value shape
const FIELD_VALUE =
	String.raw`[ \t]*(?:"((?:\\.|[^"\\\r\n])*)"|'((?:''|[^'\r\n])*)'|([^\r\n]*))` +
	String.raw`[ \t]*\r?$`;

// Field patterns
const FIELD_PATTERNS: Record<Field, RegExp> = {
	title: new RegExp(`^title:${FIELD_VALUE}`, "m"),
	description: new RegExp(`^description:${FIELD_VALUE}`, "m"),
};

// Field text
function value(frontmatter: string, key: Field): string {
	const match = frontmatter.match(FIELD_PATTERNS[key]);
	if (!match) return "";

	return normalizeText(decodeHtmlEntities(rawValue(match)));
}

// Raw value
function rawValue(match: RegExpMatchArray): string {
	if (match[1] !== undefined) return unescapeDoubleQuoted(match[1]);
	if (match[2] !== undefined) return match[2].replace(/''/g, "'");

	return match[3] ?? "";
}

// Quote escapes
function unescapeDoubleQuoted(raw: string): string {
	return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape: string) => {
		if (escape[0] === "u") {
			const code = Number.parseInt(escape.slice(1), HEX_RADIX);

			return Number.isNaN(code) ? escape : String.fromCharCode(code);
		}

		return DOUBLE_QUOTE_ESCAPES[escape] ?? escape;
	});
}
