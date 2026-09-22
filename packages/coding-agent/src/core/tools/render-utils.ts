import * as os from "node:os";
import { sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@huranth/gama-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@huranth/gama-tui";
import { keyHint } from "../../modes/tui/parts/keybinding-hints.ts";
import type { Theme } from "../../modes/tui/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { formatPathRelativeToCwdOrAbsolute, resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

type RenderBlock = { type: string; text?: string; data?: string; mimeType?: string };

const COLLAPSED_ARGS_CHARS = 100;

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}${sep}`)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export const TOOL_BODY_INDENT = 2;

export function toolHeader(theme: Theme, verb: string, detail?: string): string {
	const title = theme.fg("toolTitle", verb);
	return detail ? `${title} ${theme.fg("accent", detail)}` : title;
}

export function indentBlock(text: string, width = TOOL_BODY_INDENT): string {
	if (!text) return text;
	const pad = " ".repeat(width);
	return text
		.split("\n")
		.map((line) => (line ? pad + line : line))
		.join("\n");
}

export function toolMoreLines(theme: Theme, remaining: number, total?: number): string {
	const totalSuffix =
		total !== undefined ? theme.fg("muted", `, ${total} total, `) : theme.fg("muted", ", ");
	return (
		theme.fg("muted", `... (${remaining} more lines`) +
		totalSuffix +
		keyHint("app.tools.expand", "to expand") +
		theme.fg("muted", ")")
	);
}

export function toolNote(theme: Theme, text: string): string {
	return theme.fg("warning", text);
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	const display = formatPathRelativeToCwdOrAbsolute(value, cwd);
	return linkPath(theme.fg("accent", display), value, cwd);
}

export function getTextOutput(
	result: { content: RenderBlock[] } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => sanitizeBinaryOutput(stripAnsi(block.text || "")).replace(/\r/g, ""))
		.join("\n");

	const images = result.content.filter((block) => block.type === "image");
	const caps = getCapabilities();

	if (images.length === 0 || (caps.images && showImages)) return text;

	const imageText = images.map(imageIndicator).join("\n");

	return text ? `${text}\n${imageText}` : imageText;
}

function imageIndicator(image: RenderBlock): string {
	const mimeType = image.mimeType ?? "image/unknown";
	const dims =
		image.data && image.mimeType
			? (getImageDimensions(image.data, image.mimeType) ?? undefined)
			: undefined;

	return imageFallback(mimeType, dims);
}

export function formatToolCallWithArgs(
	title: string,
	args: unknown,
	theme: Theme,
	expanded: boolean,
): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (args == null) return header;
	const entries =
		typeof args === "object" && !Array.isArray(args)
			? Object.entries(args)
			: ([["args", args]] as [string, unknown][]);
	if (entries.length === 0) return header;
	if (expanded) return `${header}\n${theme.fg("muted", expandedArgs(entries))}`;

	const pairs = entries
		.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`)
		.join(" ");

	return `${header} ${theme.fg("muted", previewArgs(pairs))}`;
}

function expandedArgs(entries: [string, unknown][]): string {
	return entries
		.map(([key, value]) => {
			const text =
				typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			const indented = replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ");

			return `  ${key}: ${indented}`;
		})
		.join("\n");
}

function previewArgs(pairs: string): string {
	if (pairs.length <= COLLAPSED_ARGS_CHARS) return pairs;

	let head = pairs.slice(0, COLLAPSED_ARGS_CHARS - 3);
	// Surrogate safe.
	if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);

	return `${head}...`;
}
