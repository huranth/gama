import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { ImageContent, TextContent } from "@huranth/gama-ai";
import { Text } from "@huranth/gama-tui";
import { getReadmePath } from "../../../config.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../../modes/tui/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import { resolveToCwd } from "../path-utils.ts";
import type { ReadToolDetails } from "../read.ts";
import { getTextOutput, renderToolPath, replaceTabs, str, toolMoreLines } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../truncate.ts";

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

const COMPACT_RESOURCE_FILE_NAMES = new Set([
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
]);

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	const offset = args?.offset;
	const limit = args?.limit;
	if (offset == null && limit == null) return "";

	const startLine = offset ?? 1;
	let range = `:${startLine}`;
	if (limit != null && limit > 0) range += `-${startLine + limit - 1}`;

	return theme.fg("muted", range);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	const range = formatReadLineRange(args, theme);

	return `${theme.fg("toolTitle", "read")} ${pathDisplay}${range}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;

	return lines.slice(0, end);
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getGamaDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (!isInsideRoot(relativePath)) return undefined;

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}

	return undefined;
}

function isInsideRoot(relativePath: string): boolean {
	if (relativePath === "" || relativePath === "..") return false;
	if (relativePath.startsWith(`..${sep}`)) return false;

	return !isAbsolute(relativePath);
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getGamaDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const range = formatReadLineRange(args, theme);
	if (classification.kind === "skill") {
		const tag = theme.fg("muted", `\x1b[1m[skill]\x1b[22m `);

		return tag + theme.fg("customMessageText", classification.label) + range;
	}

	const title = theme.fg("toolTitle", `read ${classification.kind}`);
	const label = theme.fg("accent", classification.label);

	return `${title} ${label}${range}`;
}

function formatReadBody(
	output: string,
	lang: string | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): string {
	const rendered = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(rendered);
	const maxLines = options.expanded ? lines.length : 10;
	const shown = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	const body = shown.map((line) => styleLine(line, lang, theme, isError)).join("\n");

	if (remaining <= 0) return body;

	return `${body}\n${toolMoreLines(theme, remaining, lines.length)}`;
}

function styleLine(line: string, lang: string | undefined, theme: Theme, isError: boolean): string {
	if (lang) return line;

	return theme.fg(isError ? "error" : "toolOutput", replaceTabs(line));
}

function formatReadTruncation(
	truncation: ReadToolDetails["truncation"],
	theme: Theme,
): string | undefined {
	if (!truncation?.truncated) return undefined;

	if (truncation.firstLineExceedsLimit) {
		const limit = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
		return theme.fg("muted", `First line exceeds ${limit} limit`);
	}

	if (truncation.truncatedBy === "lines") {
		const lineLimit = truncation.maxLines ?? DEFAULT_MAX_LINES;
		const counts = `${truncation.outputLines} of ${truncation.totalLines} lines`;
		return theme.fg("muted", `Truncated: showing ${counts} (${lineLimit} line limit)`);
	}

	const limit = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
	const shown = `${truncation.outputLines} lines shown`;

	return theme.fg("muted", `Truncated: ${shown} (${limit} limit)`);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	if (!options.expanded && !isError) return "";

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	let text = `\n\n${formatReadBody(output, lang, options, theme, isError)}`;

	const truncation = formatReadTruncation(result.details?.truncation, theme);
	if (truncation) text += `\n${truncation}`;

	return text;
}

export const readRenderers: Pick<
	ToolDefinition<any, ReadToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(rawArgs, theme, context) {
		const args = rawArgs as ReadRenderArgs | undefined;
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const classification = !context.expanded
			? getCompactReadClassification(args, context.cwd)
			: undefined;
		text.setText(
			classification
				? formatCompactReadCall(classification, args, theme)
				: formatReadCall(args, theme, context.cwd),
		);
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatReadResult(
				context.args as ReadRenderArgs | undefined,
				result,
				options,
				theme,
				context.showImages,
				context.isError,
			),
		);
		return text;
	},
};
