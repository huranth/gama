import type { Theme } from "../../../term/theme/theme.ts";
import type { ToolRenderResultOptions } from "../../ext/types.ts";
import { toolMoreLines } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

type TruncationLike = { truncated?: boolean; maxBytes?: number } | undefined;

function styleLine(line: string, theme: Theme, isError: boolean): string {
	return theme.fg(isError ? "error" : "toolOutput", line);
}

export function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;

	return lines.slice(0, end);
}

// Preview window
export function previewBody(
	lines: string[],
	options: ToolRenderResultOptions,
	theme: Theme,
	maxLines: number,
): string {
	const count = options.expanded ? lines.length : maxLines;
	const shown = lines.slice(0, count);
	const remaining = lines.length - count;
	const body = shown.join("\n");

	if (remaining <= 0) return body;

	return `${body}\n${toolMoreLines(theme, remaining, lines.length)}`;
}

// Byte limit
export function byteLimitLabel(truncation: TruncationLike): string | undefined {
	if (!truncation?.truncated) return undefined;

	const maxBytes = truncation.maxBytes ?? DEFAULT_MAX_BYTES;

	return `${formatSize(maxBytes)} limit`;
}

export function warningText(theme: Theme, warnings: string[]): string | undefined {
	if (warnings.length === 0) return undefined;

	return theme.fg("muted", `Truncated: ${warnings.join(", ")}`);
}

export function formatResultBlock(
	output: string,
	warning: string | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	maxLines: number,
): string {
	const parts: string[] = [];

	if (output) {
		const lines = output.split("\n").map((line) => styleLine(line, theme, isError));
		parts.push(`\n\n${previewBody(lines, options, theme, maxLines)}`);
	}

	if (warning) parts.push(`\n${warning}`);

	return parts.join("");
}
