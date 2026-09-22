import { Text } from "@huranth/gama-tui";
import type { Theme } from "../../../modes/tui/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { LsToolDetails } from "../ls.ts";
import { getTextOutput, renderToolPath, str, toolMoreLines } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

type LsArgs = { path?: string; limit?: number } | undefined;

type LsResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: LsToolDetails;
};

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

function formatLsCall(args: LsArgs, theme: Theme, cwd: string): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", "ls")} ${pathDisplay}`;

	if (limit !== undefined) text += ` ${theme.fg("dim", `limit ${limit}`)}`;

	return text;
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
	const maxLines = options.expanded ? lines.length : 20;
	const shown = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	const body = shown.map((line) => styleLine(line, theme, isError)).join("\n");

	if (remaining <= 0) return body;

	return `${body}\n${toolMoreLines(theme, remaining, lines.length)}`;
}

function formatWarning(result: LsResult, theme: Theme): string | undefined {
	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;
	const warnings: string[] = [];

	if (entryLimit) warnings.push(`${entryLimit} entries limit`);

	if (truncation?.truncated) {
		const maxBytes = truncation.maxBytes ?? DEFAULT_MAX_BYTES;
		warnings.push(`${formatSize(maxBytes)} limit`);
	}

	if (warnings.length === 0) return undefined;

	return theme.fg("muted", `Truncated: ${warnings.join(", ")}`);
}

function formatLsResult(
	result: LsResult,
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
