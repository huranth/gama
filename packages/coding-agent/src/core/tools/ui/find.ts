import { Text } from "@huranth/gama-tui";
import type { Theme } from "../../../modes/tui/theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { FindToolDetails } from "../find.ts";
import { getTextOutput, invalidArgText, str, toolMoreLines } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

type FindArgs = { pattern: string; path?: string; limit?: number } | undefined;

type FindResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: FindToolDetails;
};

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

	if (pattern !== null && pattern) parts.push(theme.fg("accent", pattern));
	else if (pattern === null) parts.push(invalidArgText(theme));

	if (path !== null && path !== ".") parts.push(theme.fg("dim", path));
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
	const maxLines = options.expanded ? lines.length : 20;
	const shown = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	const body = shown.map((line) => styleLine(line, theme, isError)).join("\n");

	if (remaining <= 0) return body;

	return `${body}\n${toolMoreLines(theme, remaining, lines.length)}`;
}

function formatWarning(result: FindResult, theme: Theme): string | undefined {
	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	const warnings: string[] = [];

	if (resultLimit) warnings.push(`${resultLimit} results limit`);

	if (truncation?.truncated) {
		const limit = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
		warnings.push(`${limit} limit`);
	}

	if (warnings.length === 0) return undefined;

	return theme.fg("muted", `Truncated: ${warnings.join(", ")}`);
}

function formatFindResult(
	result: FindResult,
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
