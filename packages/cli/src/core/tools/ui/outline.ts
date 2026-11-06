import { Text } from "@huranth/gama-tui";
import type { Theme } from "../../../term/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { OutlineToolDetails } from "../outline.ts";
import { getTextOutput, renderToolPath, str } from "../render-utils.ts";
import { formatResultBlock, warningText } from "./format.ts";

const OUTLINE_PREVIEW_LINES = 20;

type OutlineArgs = { path?: string; limit?: number } | undefined;

type OutlineResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: OutlineToolDetails;
};

function formatOutlineCall(args: OutlineArgs, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd);
	let text = `${theme.fg("toolTitle", "outline")} ${pathDisplay}`;

	if (args?.limit !== undefined) text += ` ${theme.fg("dim", `limit ${args.limit}`)}`;

	return text;
}

function formatOutlineResult(
	result: OutlineResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	isError: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	const warning = result.details?.truncated ? warningText(theme, ["entry limit"]) : undefined;

	return formatResultBlock(output, warning, options, theme, isError, OUTLINE_PREVIEW_LINES);
}

export const outlineRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatOutlineCall(args as OutlineArgs, theme, context.cwd));

		return text;
	},

	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatOutlineResult(
				result as OutlineResult,
				options,
				theme,
				context.showImages,
				context.isError,
			),
		);

		return text;
	},
};
