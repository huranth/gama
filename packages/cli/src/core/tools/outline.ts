import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import nodePath from "node:path";
import type { AgentTool } from "@huranth/gama-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { assertNotAborted } from "./abort.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_LIMIT = 200;

const MAX_LIMIT = 1000;

const MIN_LIMIT = 1;

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const MAX_OUTPUT_BYTES = 16 * 1024;

const FOOTER_RESERVE = 64;

// Named fragments
// Exact joining
const joinPattern = (parts: string[]): RegExp => new RegExp(parts.join(""));

const joinAlternatives = (parts: string[]): string => parts.join("|");

const outlineSchema = Type.Object({
	path: Type.String({ description: "Path to the file to index (relative or absolute)" }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of entries (default: ${DEFAULT_LIMIT})` }),
	),
});

export type OutlineToolInput = Static<typeof outlineSchema>;

export interface OutlineEntry {
	start: number;
	end: number;
	name: string;
	depth: number;
}

export interface OutlineToolDetails {
	entries: OutlineEntry[];
	truncated: boolean;
	language?: string;
}

export interface OutlineToolOptions {}

export const outlineToolSystemPromptContribution = {
	snippet: "File outline",
	guidelines: ["Outline before read"],
} as const;

type Language =
	| "ts"
	| "python"
	| "rust"
	| "go"
	| "java"
	| "kotlin"
	| "csharp"
	| "c"
	| "cpp"
	| "swift"
	| "ruby"
	| "bash"
	| "markdown"
	| "json"
	| "yaml"
	| "toml";

type CommentRules = {
	line?: string;
	block?: [string, string];
	strings: string[];
};

type Item = {
	start: number;
	name: string;
	depth: number;
};

// Language table
const EXTENSIONS: Record<string, Language> = {
	ts: "ts",
	tsx: "ts",
	js: "ts",
	jsx: "ts",
	mjs: "ts",
	cjs: "ts",
	mts: "ts",
	cts: "ts",
	py: "python",
	pyi: "python",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	cs: "csharp",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hxx: "cpp",
	hh: "cpp",
	swift: "swift",
	rb: "ruby",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	json: "json",
	jsonc: "json",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
};

const FILENAMES: Record<string, Language> = {
	"cmakelists.txt": "bash",
	dockerfile: "bash",
	makefile: "bash",
	"package.json": "json",
};

const C_STYLE: CommentRules = {
	line: "//",
	block: ["/*", "*/"],
	strings: ['"""', "'''", '"', "'", "`"],
};

const RUST_STYLE: CommentRules = {
	line: "//",
	block: ["/*", "*/"],
	strings: ['"', "'"],
};

const PYTHON_STYLE: CommentRules = {
	line: "#",
	strings: ['"""', "'''", '"', "'"],
};

const HASH_STYLE: CommentRules = {
	line: "#",
	strings: ['"""', "'''", '"', "'"],
};

const RUBY_STYLE: CommentRules = {
	line: "#",
	strings: ['"', "'", "`"],
};

const BASH_STYLE: CommentRules = {
	line: "#",
	strings: ['"', "'", "`"],
};

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;

	return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function detectLanguage(filePath: string): Language | undefined {
	const base = nodePath.basename(filePath).toLowerCase();
	if (FILENAMES[base]) return FILENAMES[base];

	const dot = base.lastIndexOf(".");
	if (dot === -1) return undefined;

	return EXTENSIONS[base.slice(dot + 1)];
}

function commentRules(language: Language | undefined): CommentRules | undefined {
	switch (language) {
		case "ts":
		case "go":
		case "java":
		case "kotlin":
		case "csharp":
		case "c":
		case "cpp":
		case "swift":
			return C_STYLE;
		case "rust":
			return RUST_STYLE;
		case "python":
			return PYTHON_STYLE;
		case "yaml":
		case "toml":
			return HASH_STYLE;
		case "ruby":
			return RUBY_STYLE;
		case "bash":
			return BASH_STYLE;
		default:
			return undefined;
	}
}

function sourceLines(source: string): string[] {
	const lines = source.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	return lines;
}

function countIndent(line: string): number {
	return line.replace(/\t/g, "    ").length - line.replace(/\t/g, "    ").trimStart().length;
}

function isBlank(line: string): boolean {
	return line.trim().length === 0;
}

function lineAt(lineStarts: number[], index: number): number {
	let low = 0;
	let high = lineStarts.length - 1;

	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (lineStarts[mid] <= index) low = mid;
		else high = mid - 1;
	}

	return low + 1;
}

// Mask strings
function maskSource(source: string, rules: CommentRules | undefined, language?: Language): string {
	if (!rules) return source;

	let out = "";
	let index = 0;
	let quote: string | undefined;
	let lineComment = false;
	let blockComment = false;

	while (index < source.length) {
		const char = source[index];
		const next = source[index + 1];
		const rest = source.slice(index);

		if (lineComment) {
			out += char === "\n" ? "\n" : " ";
			lineComment = char !== "\n";
			index += 1;
			continue;
		}

		if (blockComment) {
			if (rules.block && rest.startsWith(rules.block[1])) {
				out += " ".repeat(rules.block[1].length);
				index += rules.block[1].length;
				blockComment = false;
				continue;
			}

			out += char === "\n" ? "\n" : " ";
			index += 1;
			continue;
		}

		if (quote) {
			if (char === "\\" && next !== undefined) {
				out += next === "\n" ? " \n" : "  ";
				index += 2;
				continue;
			}

			if (rest.startsWith(quote)) {
				out += " ".repeat(quote.length);
				index += quote.length;
				quote = undefined;
				continue;
			}

			out += char === "\n" ? "\n" : " ";
			index += 1;
			continue;
		}

		if (rules.line && rest.startsWith(rules.line)) {
			out += " ".repeat(rules.line.length);
			index += rules.line.length;
			lineComment = true;
			continue;
		}

		if (rules.block && rest.startsWith(rules.block[0])) {
			out += " ".repeat(rules.block[0].length);
			index += rules.block[0].length;
			blockComment = true;
			continue;
		}

		if (language === "rust" && char === "'" && /[A-Za-z_]/.test(next ?? "")) {
			const after = source[index + 2];
			if (after !== "'") {
				out += char;
				index += 1;
				continue;
			}
		}

		const opening = rules.strings.find((value) => rest.startsWith(value));
		if (opening) {
			out += " ".repeat(opening.length);
			index += opening.length;
			quote = opening;
			continue;
		}

		out += char;
		index += 1;
	}

	return out;
}

// Brace ranges
function lineDepths(lines: string[]): number[] {
	const depths: number[] = [];
	let depth = 0;

	for (const line of lines) {
		depths.push(depth);
		for (const char of line) {
			if (char === "{") depth += 1;
			if (char === "}") depth -= 1;
		}
	}

	return depths;
}

function findBraceEnd(lines: string[], start: number, baseDepth: number): number {
	let depth = baseDepth;
	let opened = false;

	for (let line = start; line < lines.length; line++) {
		for (const char of lines[line]) {
			if (char === "{") {
				depth += 1;
				opened = true;
			}
			if (char === "}") {
				depth -= 1;
				if (opened && depth <= baseDepth) return line;
			}
		}
	}

	return lines.length - 1;
}

function findDeclarationEnd(lines: string[], start: number, baseDepth: number): number {
	const limit = Math.min(lines.length, start + 30);

	for (let line = start; line < limit; line++) {
		for (let index = 0; index < lines[line].length; index++) {
			const char = lines[line][index];
			if (char === "{") return findBraceEnd(lines, line, baseDepth);
			if (char === ";") return line;
		}

		if (line === start && !lines[line].includes("=")) continue;
		if (!lines[line].trimEnd().endsWith("=")) break;
	}

	return start;
}

function makeEntry(start: number, end: number, name: string, depth: number): OutlineEntry {
	return { start: start + 1, end: Math.max(start, end) + 1, name, depth };
}

// Language scanners
function scanTs(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const depths = lineDepths(lines);
	const tsModifiers = [
		"(?:export\\s+)?",
		"(?:default\\s+)?",
		"(?:declare\\s+)?",
		"(?:abstract\\s+)?",
		"(?:async\\s+)?",
	];
	const tsKeywords = [
		"(?:(const|let|var)\\s+enum|",
		"(function\\s*\\*?|class|interface|type|enum|namespace|module|const|let|var))",
	];
	const pattern = joinPattern([
		"^\\s*",
		...tsModifiers,
		...tsKeywords,
		"\\s+",
		"([A-Za-z_$][\\w$]*)",
	]);

	for (let line = 0; line < lines.length; line++) {
		if (depths[line] !== 0) continue;

		const match = pattern.exec(lines[line]);
		if (!match) continue;

		const keyword = match[2] ? match[2].replace("*", "").trim() : `${match[1]} enum`;
		const name = `${keyword} ${match[3]}`;
		const end = findDeclarationEnd(lines, line, 0);
		entries.push(makeEntry(line, end, name, 0));

		if (keyword === "class") entries.push(...scanTsMembers(lines, depths, line, end));
	}

	return entries;
}

function scanTsMembers(
	lines: string[],
	depths: number[],
	start: number,
	end: number,
): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const memberModifiers = joinAlternatives([
		"public",
		"private",
		"protected",
		"static",
		"readonly",
		"abstract",
		"override",
		"declare",
	]);
	const methodModifiers = joinAlternatives([memberModifiers, "async", "get", "set"]);
	const memberIdent = "#?([A-Za-z_$][\\w$]*)";
	const method = joinPattern([
		"^\\s*(?:(?:",
		methodModifiers,
		")\\s+)*",
		memberIdent,
		"\\s*(?:<[^>]*>)?\\s*\\(",
	]);
	const field = joinPattern([
		"^\\s*(?:(?:",
		memberModifiers,
		")\\s+)*",
		memberIdent,
		"\\s*[?!]?\\s*[:=]",
	]);

	for (let line = start + 1; line < end; line++) {
		if (depths[line] !== 1) continue;

		const methodMatch = method.exec(lines[line]);
		if (methodMatch) {
			const stop = findDeclarationEnd(lines, line, 1);
			entries.push(makeEntry(line, stop, `method ${methodMatch[1]}`, 1));
			continue;
		}

		const fieldMatch = field.exec(lines[line]);
		if (fieldMatch) entries.push(makeEntry(line, line, `field ${fieldMatch[1]}`, 1));
	}

	return entries;
}

function scanPython(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const indents: number[] = [];
	const pattern = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;

	for (let line = 0; line < lines.length; line++) {
		const match = pattern.exec(lines[line]);
		if (!match) continue;

		const indent = countIndent(lines[line]);
		while (indents.length > 0 && indent <= indents[indents.length - 1]) indents.pop();

		let end = line;
		for (let next = line + 1; next < lines.length; next++) {
			if (isBlank(lines[next])) continue;
			if (countIndent(lines[next]) <= indent) break;
			end = next;
		}

		entries.push(makeEntry(line, end, `${match[2]} ${match[3]}`, indents.length));
		indents.push(indent);
	}

	return entries;
}

function scanRust(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const depths = lineDepths(lines);
	const rustPub = "(?:pub(?:\\([^)]*\\))?\\s+)?";
	const fnPattern = joinPattern([
		"^\\s*",
		rustPub,
		"(?:async\\s+)?",
		"(?:const\\s+)?",
		"(?:unsafe\\s+)?",
		'(?:extern\\s+"[^"]*"\\s+)?',
		"fn\\s+",
		"([A-Za-z_]\\w*)",
	]);
	const rustItems = joinAlternatives([
		"struct",
		"enum",
		"trait",
		"impl",
		"mod",
		"const",
		"static",
		"type",
	]);
	const itemPattern = joinPattern([
		"^\\s*",
		rustPub,
		`(${rustItems})`,
		"\\b\\s*",
		"(?:<[^>]*>\\s*)?",
		"([A-Za-z_]\\w*)?",
	]);

	for (let line = 0; line < lines.length; line++) {
		if (depths[line] !== 0) continue;

		const fnMatch = fnPattern.exec(lines[line]);
		const itemMatch = itemPattern.exec(lines[line]);
		const match = fnMatch ?? itemMatch;
		if (!match) continue;

		const name = fnMatch
			? `fn ${fnMatch[1]}`
			: [itemMatch?.[1], itemMatch?.[2]].filter(Boolean).join(" ");
		entries.push(makeEntry(line, findDeclarationEnd(lines, line, 0), name, 0));
	}

	return entries;
}

function scanGo(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const depths = lineDepths(lines);
	const funcPattern = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/;
	const typePattern = /^\s*type\s+([A-Za-z_]\w*)/;

	for (let line = 0; line < lines.length; line++) {
		if (depths[line] !== 0) continue;

		const funcMatch = funcPattern.exec(lines[line]);
		const typeMatch = typePattern.exec(lines[line]);
		const match = funcMatch ?? typeMatch;
		if (!match) continue;

		const name = `${funcMatch ? "func" : "type"} ${match[1]}`;
		entries.push(makeEntry(line, findDeclarationEnd(lines, line, 0), name, 0));
	}

	return entries;
}

const CONTROL_NAMES = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"new",
	"else",
	"do",
	"try",
	"finally",
	"throw",
	"synchronized",
]);

function scanCFamily(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const depths = lineDepths(lines);
	const typeModifiers = joinAlternatives([
		"export",
		"public",
		"private",
		"protected",
		"internal",
		"static",
		"final",
		"abstract",
		"sealed",
		"data",
		"open",
		"partial",
		"fileprivate",
		"pub",
	]);
	const typeKeywords = joinAlternatives([
		"class",
		"interface",
		"enum",
		"struct",
		"record",
		"namespace",
		"protocol",
		"extension",
		"actor",
		"object",
	]);
	const typePattern = joinPattern([
		"^\\s*(?:(?:",
		typeModifiers,
		")\\s+)*(",
		typeKeywords,
		")\\s+([A-Za-z_]\\w*)",
	]);
	const funcModifiers = joinAlternatives([
		"public",
		"private",
		"protected",
		"internal",
		"static",
		"final",
		"abstract",
		"virtual",
		"override",
		"async",
		"native",
		"inline",
		"constexpr",
		"extern",
		"unsafe",
		"suspend",
		"open",
	]);
	const funcPattern = joinPattern([
		"^\\s*(?:(?:",
		funcModifiers,
		")\\s+)*",
		"(?:[\\w:$<>\\[\\],.?*&~]+\\s+)*",
		"([A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*)\\s*\\(",
	]);
	const namedFuncModifiers = joinAlternatives([
		"public",
		"private",
		"protected",
		"internal",
		"static",
		"final",
		"open",
	]);
	const namedFuncPattern = joinPattern([
		"^\\s*(?:(?:",
		namedFuncModifiers,
		")\\s+)*(?:fun|func)\\s+([A-Za-z_]\\w*)",
	]);

	for (let line = 0; line < lines.length; line++) {
		const depth = depths[line];
		if (depth > 1) continue;

		const typeMatch = typePattern.exec(lines[line]);
		if (typeMatch) {
			const name = `${typeMatch[1]} ${typeMatch[2]}`;
			entries.push(makeEntry(line, findDeclarationEnd(lines, line, depth), name, depth));
			continue;
		}

		const match = namedFuncPattern.exec(lines[line]) ?? funcPattern.exec(lines[line]);
		if (!match || CONTROL_NAMES.has(match[1])) continue;

		const keyword = namedFuncPattern.test(lines[line]) ? "func" : "function";
		const end = findDeclarationEnd(lines, line, depth);
		entries.push(makeEntry(line, end, `${keyword} ${match[1]}`, depth));
	}

	return entries;
}

function scanBash(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const depths = lineDepths(lines);
	const patterns = [
		/^\s*function\s+([A-Za-z_][\w-]*)\s*(?:\(\s*\))?/,
		/^\s*([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/,
	];

	for (let line = 0; line < lines.length; line++) {
		if (depths[line] !== 0) continue;

		for (const pattern of patterns) {
			const match = pattern.exec(lines[line]);
			if (!match) continue;

			entries.push(makeEntry(line, findBraceEnd(lines, line, 0), match[1], 0));
			break;
		}
	}

	return entries;
}

function rubyOpener(line: string): string | undefined {
	const plain = line.trim();
	const match = /^(def|class|module|if|unless|while|until|case|begin|for|do)\b/.exec(plain);
	if (match) return match[1];
	if (/\bdo\s*(?:\|[^|]*\|)?\s*$/.test(plain)) return "do";

	return undefined;
}

function scanRuby(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const stack: Array<{ start: number; name?: string; depth: number }> = [];

	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];

		if (/^\s*end\b/.test(text)) {
			const item = stack.pop();
			if (item?.name) entries.push(makeEntry(item.start, line, item.name, item.depth));
			continue;
		}

		const opener = rubyOpener(text);
		if (!opener) continue;

		const nameMatch =
			opener === "def"
				? /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/
				: /^\s*(?:class|module)\s+([A-Za-z_]\w*[?!]?)/;
		const name = nameMatch.exec(text)?.[1];
		const depth = stack.length;
		stack.push(name ? { start: line, name: `${opener} ${name}`, depth } : { start: line, depth });
	}

	return entries;
}

function scanMarkdown(lines: string[]): OutlineEntry[] {
	const items: Item[] = [];
	let fence: string | undefined;

	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];
		const fenceMatch = /^\s*(```|~~~)/.exec(text);
		if (fenceMatch) {
			if (!fence) fence = fenceMatch[1];
			else if (fence === fenceMatch[1]) fence = undefined;
			continue;
		}
		if (fence) continue;

		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
		if (heading) {
			items.push({ start: line, name: heading[2].trim(), depth: 0 });
			continue;
		}

		const underline = lines[line + 1]?.match(/^(=+|-+)\s*$/);
		if (underline && !isBlank(text)) items.push({ start: line, name: text.trim(), depth: 0 });
	}

	return items.map((item, index) => {
		const next = items[index + 1]?.start ?? lines.length;
		return makeEntry(item.start, next - 1, item.name, item.depth);
	});
}

function scanJson(source: string, lines: string[]): OutlineEntry[] {
	const lineStarts = [0];
	for (let index = 0; index < source.length; index++) {
		if (source[index] === "\n") lineStarts.push(index + 1);
	}

	const keys: Array<{ start: number; name: string }> = [];
	let depth = 0;
	let quote = false;
	let escaped = false;
	let text = "";
	let closeLine = lines.length;

	for (let index = 0; index < source.length; index++) {
		const char = source[index];

		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				quote = false;
				let next = index + 1;
				while (/\s/.test(source[next] ?? "")) next++;
				if (depth === 1 && source[next] === ":") {
					keys.push({ start: lineAt(lineStarts, index), name: text });
				}
				continue;
			}
			text += char;
			continue;
		}

		if (char === '"') {
			quote = true;
			text = "";
			continue;
		}
		if (char === "{" || char === "[") depth += 1;
		if (char === "}" || char === "]") {
			depth -= 1;
			if (depth === 0) closeLine = lineAt(lineStarts, index);
		}
	}

	return keys.map((key, index) => {
		const start = key.start - 1;
		const next = keys[index + 1]?.start ?? closeLine;
		const end = Math.max(start, next - 2);

		return makeEntry(start, end, key.name, 0);
	});
}

function scanKeyLines(lines: string[], language: Language): OutlineEntry[] {
	const items: Item[] = [];
	const yamlKey = /^([^\s#][^:]*?)\s*:\s*(?:.*)$/;
	const tomlKey = /^([A-Za-z0-9_.-]+)\s*=/;
	const tomlTable = /^\[([^\]]+)\]\s*$/;

	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];
		if (language === "yaml") {
			const match = yamlKey.exec(text);
			if (!match || /^(---|\.\.\.)\s*$/.test(text)) continue;
			items.push({ start: line, name: match[1].trim().replace(/^['"]|['"]$/g, ""), depth: 0 });
			continue;
		}

		const table = tomlTable.exec(text);
		if (table) {
			items.push({ start: line, name: table[1], depth: 0 });
			continue;
		}

		const match = tomlKey.exec(text);
		if (match) items.push({ start: line, name: match[1], depth: 0 });
	}

	return items.map((item, index) => {
		const next = items[index + 1]?.start ?? lines.length;
		return makeEntry(item.start, next - 1, item.name, item.depth);
	});
}

function scanFallback(lines: string[]): OutlineEntry[] {
	const entries: OutlineEntry[] = [];
	const fallbackModifiers = joinAlternatives([
		"public",
		"private",
		"protected",
		"internal",
		"static",
		"final",
		"async",
		"abstract",
	]);
	const fallbackKeywords = joinAlternatives([
		"function",
		"class",
		"interface",
		"struct",
		"enum",
		"type",
		"def",
		"fn",
		"func",
		"const",
		"let",
		"var",
		"module",
		"namespace",
		"trait",
		"impl",
	]);
	const pattern = joinPattern([
		"^\\s*(?:export\\s+)?(?:(?:",
		fallbackModifiers,
		")\\s+)?(",
		fallbackKeywords,
		")\\b\\s*([A-Za-z_$][\\w$]*)?",
	]);

	for (let line = 0; line < lines.length; line++) {
		const match = pattern.exec(lines[line]);
		if (!match) continue;

		const name = [match[1], match[2]].filter(Boolean).join(" ");
		entries.push(makeEntry(line, findDeclarationEnd(lines, line, 0), name, 0));
	}

	return entries;
}

function scanSource(source: string, language: Language | undefined): OutlineEntry[] {
	const lines = sourceLines(source);
	const raw =
		language === "markdown" || language === "json" || language === "yaml" || language === "toml";
	const masked = raw ? lines : sourceLines(maskSource(source, commentRules(language), language));

	switch (language) {
		case "ts":
			return scanTs(masked);
		case "python":
			return scanPython(masked);
		case "rust":
			return scanRust(masked);
		case "go":
			return scanGo(masked);
		case "bash":
			return scanBash(masked);
		case "ruby":
			return scanRuby(masked);
		case "markdown":
			return scanMarkdown(raw ? lines : masked);
		case "json":
			return scanJson(source, lines);
		case "yaml":
		case "toml":
			return scanKeyLines(lines, language);
		case "java":
		case "kotlin":
		case "csharp":
		case "c":
		case "cpp":
		case "swift":
			return scanCFamily(masked);
		default:
			return scanFallback(masked);
	}
}

function sortEntries(entries: OutlineEntry[]): OutlineEntry[] {
	return [...entries].sort((a, b) => a.start - b.start || a.depth - b.depth || a.end - b.end);
}

function cleanName(name: string): string {
	return name.replace(/\s+/g, " ").trim();
}

function formatEntry(entry: OutlineEntry): string {
	const indent = "  ".repeat(entry.depth + 1);

	return `${indent}${entry.start}-${entry.end} ${cleanName(entry.name)}`;
}

// Render output
function renderIndex(
	displayPath: string,
	lineCount: number,
	entries: OutlineEntry[],
	limit: number,
): { text: string; details: OutlineToolDetails } {
	const sorted = sortEntries(entries);
	const lines: string[] = [];
	const shown: OutlineEntry[] = [];
	let bytes = Buffer.byteLength(`${displayPath} (${lineCount} lines)\n`, "utf-8");

	for (const entry of sorted) {
		if (shown.length >= limit) break;

		const line = formatEntry(entry);
		const lineBytes = Buffer.byteLength(line, "utf-8") + (lines.length > 0 ? 1 : 0);
		if (bytes + lineBytes + FOOTER_RESERVE > MAX_OUTPUT_BYTES) break;

		lines.push(line);
		shown.push(entry);
		bytes += lineBytes;
	}

	const remaining = sorted.length - shown.length;
	let text = `${displayPath} (${lineCount} lines)`;

	if (lines.length > 0) text += `\n${lines.join("\n")}`;
	if (remaining > 0) text += `\n... ${remaining} more`;

	return {
		text,
		details: {
			entries: shown,
			truncated: remaining > 0 || sorted.length > limit,
		},
	};
}

// Tool factory
export function createOutlineTool(
	cwd: string,
	options?: OutlineToolOptions,
): AgentTool<typeof outlineSchema> {
	return wrapToolDefinition(createOutlineToolDefinition(cwd, options));
}

export function createOutlineToolDefinition(
	cwd: string,
	_options?: OutlineToolOptions,
): ToolDefinition<typeof outlineSchema, OutlineToolDetails> {
	return {
		name: "outline",
		label: "outline",
		description:
			"Outline a file with exact start-end line ranges so you can read only what matters. " +
			"Supports common languages, Markdown, JSON, YAML, and TOML. " +
			`Output is capped at ${DEFAULT_LIMIT} entries and ${MAX_OUTPUT_BYTES / 1024}KB.`,
		promptSnippet: outlineToolSystemPromptContribution.snippet,
		promptGuidelines: [...outlineToolSystemPromptContribution.guidelines],
		parameters: outlineSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			assertNotAborted(signal);

			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const stats = await fsStat(absolutePath).catch((error: unknown) => {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") {
					throw new Error("Path missing");
				}
				const reason = error instanceof Error ? error.message : "unknown";
				throw new Error(`Read failed: ${reason}`);
			});

			if (!stats.isFile()) throw new Error("Not a file");
			if (stats.size > MAX_FILE_BYTES) throw new Error("File too large");

			const buffer = await fsReadFile(absolutePath).catch((error: unknown) => {
				const reason = error instanceof Error ? error.message : "unknown";
				throw new Error(`Read failed: ${reason}`);
			});

			assertNotAborted(signal);

			if (buffer.length > MAX_FILE_BYTES) throw new Error("File too large");

			const source = buffer.toString("utf-8");
			const language = detectLanguage(absolutePath);
			const entries = scanSource(source, language);
			const result = renderIndex(
				path,
				sourceLines(source).length,
				entries,
				normalizeLimit(limit),
			);

			return {
				content: [{ type: "text" as const, text: result.text }],
				details: language ? { ...result.details, language } : result.details,
			};
		},
	};
}
