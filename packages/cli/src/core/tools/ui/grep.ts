import { Text } from "@huranth/gama-tui";
import type { Theme } from "../../../term/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { GrepToolDetails } from "../grep.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { byteLimitLabel, formatResultBlock, warningText } from "./format.ts";

const GREP_PREVIEW_LINES = 15;

type GrepArgs = { pattern: string; path?: string; glob?: string; limit?: number } | undefined;

type GrepResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: GrepToolDetails;
};

function formatGrepCall(args: GrepArgs, theme: Theme, cwd: string): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath ? formatPathRelativeToCwdOrAbsolute(rawPath, cwd) : ".";
	const glob = str(args?.glob);
	const limit = args?.limit;
	const parts = [theme.fg("toolTitle", "grep")];

	if (pattern) parts.push(theme.fg("accent", `/${pattern}/`));
	else if (pattern === null) parts.push(invalidArgText(theme));

	if (rawPath && path !== ".") parts.push(theme.fg("dim", path));

	if (glob) parts.push(theme.fg("dim", glob));

	if (limit !== undefined) parts.push(theme.fg("dim", `limit ${limit}`));

	return parts.join(" ");
}

function formatWarning(result: GrepResult, theme: Theme): string | undefined {
	const matchLimit = result.details?.matchLimitReached;
	const sizeLimit = byteLimitLabel(result.details?.truncation);
	const linesTruncated = result.details?.linesTruncated;
	const warnings: string[] = [];

	if (matchLimit) warnings.push(`${matchLimit} matches limit`);

	if (sizeLimit) warnings.push(sizeLimit);

	if (linesTruncated) warnings.push("some lines truncated");

	return warningText(theme, warnings);
}

function formatGrepResult(
	result: GrepResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	const warning = formatWarning(result, theme);

	return formatResultBlock(output, warning, options, theme, isError, GREP_PREVIEW_LINES);
}

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
