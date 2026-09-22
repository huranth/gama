import { Container, Text } from "@huranth/gama-tui";
import { keyHint } from "../../../modes/tui/parts/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../../modes/tui/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "../render-utils.ts";

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;

	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);

	for (let i = 0; i < prefixCount; i++) {
		const line = cache.normalizedLines[i] ?? "";
		cache.highlightedLines[i] = prefixHighlighted[i] ?? highlightSingleLine(line, cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;

	const normalized = replaceTabs(normalizeDisplayText(fileContent));

	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;

	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) {
		return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	}

	if (!fileContent.startsWith(cache.rawContent)) {
		return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	}

	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaNormalized = replaceTabs(normalizeDisplayText(deltaRaw));
	cache.rawContent = fileContent;

	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(
		cache.normalizedLines[lastIndex],
		cache.lang,
	);

	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}

	refreshWriteHighlightPrefix(cache);

	return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;

	return lines.slice(0, end);
}

function getRenderedLines(
	fileContent: string,
	lang: string | undefined,
	cache: WriteHighlightCache | undefined,
): string[] {
	const text = normalizeDisplayText(fileContent);
	if (!lang) return text.split("\n");
	if (cache) return cache.highlightedLines;

	return highlightCode(replaceTabs(text), lang);
}

function formatPreviewBody(
	fileContent: string,
	lang: string | undefined,
	cache: WriteHighlightCache | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
): { body: string; remaining: number; totalLines: number } {
	const rendered = getRenderedLines(fileContent, lang, cache);
	const lines = trimTrailingEmptyLines(rendered);
	const totalLines = lines.length;
	const maxLines = options.expanded ? lines.length : 10;
	const shown = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	const body = shown
		.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line))))
		.join("\n");

	return { body, remaining, totalLines };
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const preview = formatPreviewBody(fileContent, lang, cache, options, theme);
		text += `\n\n${preview.body}`;

		if (preview.remaining > 0) {
			const more = theme.fg(
				"muted",
				`\n... (${preview.remaining} more lines, ${preview.totalLines} total,`,
			);
			const expand = keyHint("app.tools.expand", "to expand");
			text += `${more} ${expand}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}

function formatWriteResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
	},
	theme: Theme,
): string | undefined {
	if (!result.isError) return undefined;

	const output = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n");
	if (!output) return undefined;

	return `\n${theme.fg("error", output)}`;
}

export const writeRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const renderArgs = args as
			| { path?: string; file_path?: string; content?: string }
			| undefined;
		const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
		const fileContent = str(renderArgs?.content);
		const component =
			(context.lastComponent as WriteCallRenderComponent | undefined) ??
			new WriteCallRenderComponent();

		if (fileContent === null) {
			component.cache = undefined;
		} else if (context.argsComplete) {
			component.cache = rebuildWriteHighlightCacheFull(rawPath, fileContent);
		} else {
			component.cache = updateWriteHighlightCacheIncremental(
				component.cache,
				rawPath,
				fileContent,
			);
		}
		component.setText(
			formatWriteCall(
				renderArgs,
				{ expanded: context.expanded, isPartial: context.isPartial },
				theme,
				component.cache,
				context.cwd,
			),
		);
		return component;
	},
	renderResult(result, _options, theme, context) {
		const output = formatWriteResult({ ...result, isError: context.isError }, theme);
		if (!output) {
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			return component;
		}
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(output);
		return text;
	},
};
