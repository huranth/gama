import { Text } from "@huranth/gama-tui";
import type { Theme } from "../../../term/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { FindToolDetails } from "../find.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { byteLimitLabel, formatResultBlock, warningText } from "./format.ts";

const FIND_PREVIEW_LINES = 20;

type FindArgs = { pattern: string; path?: string; limit?: number } | undefined;

type FindResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: FindToolDetails;
};

function resolveDisplayPath(rawPath: string | null, cwd: string): string | null {
	if (rawPath === null) return null;
	if (!rawPath) return ".";

	return formatPathRelativeToCwdOrAbsolute(rawPath, cwd);
}

function formatFindCall(args: FindArgs, theme: Theme, cwd: string): string {
	const pattern = str(args?.pattern);
	const path = resolveDisplayPath(str(args?.path), cwd);
	const limit = args?.limit;
	const parts = [theme.fg("toolTitle", "find")];

	if (pattern) parts.push(theme.fg("accent", pattern));
	else if (pattern === null) parts.push(invalidArgText(theme));

	if (path !== null && path !== ".") parts.push(theme.fg("dim", path));

	if (limit !== undefined) parts.push(theme.fg("dim", `limit ${limit}`));

	return parts.join(" ");
}

function formatWarning(result: FindResult, theme: Theme): string | undefined {
	const resultLimit = result.details?.resultLimitReached;
	const sizeLimit = byteLimitLabel(result.details?.truncation);
	const warnings: string[] = [];

	if (resultLimit) warnings.push(`${resultLimit} results limit`);

	if (sizeLimit) warnings.push(sizeLimit);

	return warningText(theme, warnings);
}

function formatFindResult(
	result: FindResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	const warning = formatWarning(result, theme);

	return formatResultBlock(output, warning, options, theme, isError, FIND_PREVIEW_LINES);
}

export const findRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatFindCall(args as FindArgs, theme, context.cwd));

		return text;
	},

	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatFindResult(
				result as FindResult,
				options,
				theme,
				context.showImages,
				context.isError,
			),
		);

		return text;
	},
};
