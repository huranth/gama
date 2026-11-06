import { Text } from "@huranth/gama-tui";
import type { Theme } from "../../../term/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { LsToolDetails } from "../ls.ts";
import { getTextOutput, renderToolPath, str } from "../render-utils.ts";
import { byteLimitLabel, formatResultBlock, warningText } from "./format.ts";

const LS_PREVIEW_LINES = 20;

type LsArgs = { path?: string; limit?: number } | undefined;

type LsResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: LsToolDetails;
};

function formatLsCall(args: LsArgs, theme: Theme, cwd: string): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", "ls")} ${pathDisplay}`;

	if (limit !== undefined) text += ` ${theme.fg("dim", `limit ${limit}`)}`;

	return text;
}

function formatWarning(result: LsResult, theme: Theme): string | undefined {
	const entryLimit = result.details?.entryLimitReached;
	const sizeLimit = byteLimitLabel(result.details?.truncation);
	const warnings: string[] = [];

	if (entryLimit) warnings.push(`${entryLimit} entries limit`);

	if (sizeLimit) warnings.push(sizeLimit);

	return warningText(theme, warnings);
}

function formatLsResult(
	result: LsResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	const warning = formatWarning(result, theme);

	return formatResultBlock(output, warning, options, theme, isError, LS_PREVIEW_LINES);
}

export const lsRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatLsCall(args as LsArgs, theme, context.cwd));

		return text;
	},

	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatLsResult(result as LsResult, options, theme, context.showImages, context.isError),
		);

		return text;
	},
};
