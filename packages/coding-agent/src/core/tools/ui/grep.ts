import { Text } from "@huranth/gama-tui";
import type { Theme } from "../../../modes/tui/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { GrepToolDetails } from "../grep.ts";
import { getTextOutput, invalidArgText, str, toolMoreLines } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

type GrepArgs = { pattern: string; path?: string; glob?: string; limit?: number } | undefined;

type GrepResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: GrepToolDetails;
};

export const grepRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGrepCall(args as GrepArgs, theme, context.cwd));

		return text;
	},

	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatGrepResult(
				result as GrepResult,
				options,
				theme,
				context.showImages,
				context.isError,
			),
		);

		return text;
	},
};

function formatGrepCall(args: GrepArgs, theme: Theme, cwd: string): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath ? formatPathRelativeToCwdOrAbsolute(rawPath, cwd) : ".";
	const glob = str(args?.glob);
	const limit = args?.limit;
	const parts = [theme.fg("toolTitle", "grep")];

	if (pattern) parts.push(theme.fg("accent", `/${pattern}/`));
	else if (args?.pattern !== undefined) parts.push(invalidArgText(theme));

	if (rawPath !== null && path !== ".") parts.push(theme.fg("dim", path));
	if (glob) parts.push(theme.fg("dim", glob));
	if (limit !== undefined) parts.push(theme.fg("dim", `limit ${limit}`));

	return parts.join(" ");
}

function styleLine(line: string, theme: Theme, isError: boolean): string {
	return theme.fg(isError ? "error" : "toolOutput", line);
}

function formatBody(
	output: string,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): string {
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 15;
	const shown = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	const body = shown.map((line) => styleLine(line, theme, isError)).join("\n");

	if (remaining <= 0) return body;

	return `${body}\n${toolMoreLines(theme, remaining, lines.length)}`;
}

function formatWarning(result: GrepResult, theme: Theme): string | undefined {
	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	const warnings: string[] = [];

	if (matchLimit) warnings.push(`${matchLimit} matches limit`);

	if (truncation?.truncated) {
		const maxBytes = truncation.maxBytes ?? DEFAULT_MAX_BYTES;
		warnings.push(`${formatSize(maxBytes)} limit`);
	}

	if (linesTruncated) warnings.push("some lines truncated");

	if (warnings.length === 0) return undefined;

	return theme.fg("muted", `Truncated: ${warnings.join(", ")}`);
}

function formatGrepResult(
	result: GrepResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";

	if (output) {
		text += `\n\n${formatBody(output, options, theme, isError)}`;
	}

	const warning = formatWarning(result, theme);
	if (warning) text += `\n${warning}`;

	return text;
}
