import { Text } from "@huranth/gama-tui";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { Theme } from "../../../term/theme/theme.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { formatResultBlock, warningText } from "./format.ts";

const WEB_PREVIEW_LINES = 12;

const SUMMARY_TITLE_CHARS = 72;

type WebContent = { type: string; text?: string };

type WebRenderers = Pick<ToolDefinition<any, any>, "renderCall" | "renderResult">;

type WebDetails = {
	truncated?: boolean;
	note?: string;
	title?: string;
	url?: string;
	finalUrl?: string;
	totalChars?: number;
	nextOffset?: number;
	matches?: number;
	pattern?: string;
};

type WebResult = {
	content?: WebContent[];
	details?: WebDetails;
};

function detailText(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function contentOf(result: WebResult | undefined): WebContent[] {
	return Array.isArray(result?.content) ? result.content : [];
}

function shortText(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function metaLine(value: WebResult | undefined, theme: Theme): string | undefined {
	const details = value?.details;
	if (!details) return undefined;

	const parts: string[] = [];
	if (typeof details.matches === "number") {
		parts.push(`${details.matches} ${details.matches === 1 ? "match" : "matches"}`);
	}
	const note = detailText(details.note);
	if (note) parts.push(note);
	if (!parts.length) return undefined;

	return theme.fg("muted", parts.join(", "));
}

function resultText(
	result: WebResult | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): string {
	const output = getTextOutput({ content: contentOf(result) }, false).trim();
	const warnings = result?.details?.truncated ? ["content limit"] : [];

	const block = formatResultBlock(
		output,
		warningText(theme, warnings),
		options,
		theme,
		isError,
		WEB_PREVIEW_LINES,
	);
	const meta = metaLine(result, theme);
	return meta ? `${block}\n${meta}` : block;
}

export const webfetchRenderers: WebRenderers = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const fromArgs = (args ?? {}) as { url?: string; find?: string };
		const fromContext = (context.args ?? {}) as { url?: string };
		const target = str(fromArgs.url) || str(fromContext.url);
		const find = str(fromArgs.find);
		const label = target || invalidArgText(theme);

		text.setText(
			target
				? `${theme.fg("toolTitle", "fetch")} ${theme.fg("accent", label)}${
						find ? theme.fg("muted", ` - find "${find}"`) : ""
					}`
				: `${theme.fg("toolTitle", "fetch")} ${label}`,
		);
		return text;
	},

	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const value = result as WebResult | undefined;

		// Collapsed line
		if (!options.expanded) {
			const details = value?.details;
			const chars =
				details?.totalChars ?? getTextOutput({ content: contentOf(value) }, false).length;
			const title = detailText(details?.title);
			const suffix = title ? ` - ${shortText(title, SUMMARY_TITLE_CHARS)}` : "";

			const label =
				typeof details?.matches === "number"
					? `${details.matches} ${details.matches === 1 ? "match" : "matches"}${suffix}`
					: `Read ${chars.toLocaleString()} chars${suffix}`;

			text.setText(theme.fg("muted", label));
			return text;
		}

		text.setText(resultText(value, options, theme, context.isError));
		return text;
	},
};
