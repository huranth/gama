import { Container, Spacer, Text } from "@huranth/gama-tui";
import type { ToolDefinition } from "../../core/ext/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHint } from "../../modes/tui/parts/keybinding-hints.ts";
import { VisualLinePreview } from "../../modes/tui/parts/visual-truncate.ts";
import { highlightCode, type Theme } from "../../modes/tui/theme/theme.ts";
import type { CodemodeNestedCall, CodemodeToolDetails } from "./tool.ts";

const COLLAPSED_ARGS_CHARS = 80;
const CODE_PREVIEW_LINES = 10;
const CALL_PREVIEW_COUNT = 8;
const OUTPUT_PREVIEW_LINES = 5;

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function statusIcon(call: CodemodeNestedCall, theme: Theme): string {
	switch (call.status) {
		case "running":
			return theme.fg("warning", "run");
		case "ok":
			return theme.fg("success", "ok");
		case "error":
			return theme.fg("error", "fail");
		case "cancelled":
			return theme.fg("muted", "skip");
	}
}

function expandHint(theme: Theme, label: string): string {
	const text = theme.fg("muted", `... (${label},`);
	const hint = keyHint("app.tools.expand", "to expand");

	return `${text} ${hint}${theme.fg("muted", ")")}`;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function formatCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean): string {
	const args =
		!expanded && call.args.length > COLLAPSED_ARGS_CHARS
			? `${call.args.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
			: call.args;
	const duration = formatDuration(call.durationMs);
	let line = `${statusIcon(call, theme)} ${theme.fg("toolTitle", call.name)}`;

	if (args) line += ` ${theme.fg("muted", args)}`;
	if (duration) line += ` ${theme.fg("dim", duration)}`;
	if (call.cost) line += ` ${theme.fg("dim", formatCost(call.cost))}`;

	if (expanded && call.error) {
		const errorText = call.error.split("\n").join("\n    ");
		line += `\n    ${theme.fg("error", errorText)}`;
	}

	return line;
}

function formatCalls(calls: CodemodeNestedCall[], theme: Theme, expanded: boolean): string[] {
	const shown = expanded ? calls : calls.slice(-CALL_PREVIEW_COUNT);
	const lines = shown.map((call) => formatCall(call, theme, expanded));

	if (shown.length < calls.length) {
		const hidden = calls.length - shown.length;
		lines.unshift(expandHint(theme, `${hidden} earlier calls`));
	}

	const priced = calls.filter((call) => call.cost);
	if (priced.length > 1) {
		const total = priced.reduce((sum, call) => sum + (call.cost ?? 0), 0);
		lines.push(theme.fg("muted", `Model calls: ${formatCost(total)}`));
	}

	return lines;
}

export const codemodeRenderers: Pick<
	ToolDefinition<any, CodemodeToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		const code = str((args as { code?: unknown } | undefined)?.code);
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (code === null) {
			component.addChild(new Text(`${title} ${theme.fg("error", "[invalid arg]")}`, 0, 0));
			return component;
		}
		component.addChild(new Text(title, 0, 0));

		if (code) {
			const source = replaceTabs(code.replace(/\r/g, "").trimEnd());
			const highlighted = highlightCode(source, "javascript").join("\n");

			component.addChild(
				context.expanded
					? new Text(highlighted, 0, 0)
					: new VisualLinePreview({
							text: highlighted,
							maxVisualLines: CODE_PREVIEW_LINES,
							keep: "start",
							formatHint: (hidden) => expandHint(theme, `${hidden} more lines`),
						}),
			);
		}

		return component;
	},
	renderResult(result, options, theme, context) {
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		const calls = result.details?.calls ?? [];
		if (calls.length > 0) {
			const lines = formatCalls(calls, theme, options.expanded);

			component.addChild(new Spacer(1));
			component.addChild(new Text(lines.join("\n"), 0, 0));
		}

		const [first, ...rest] = result.content;
		const hasHeader = first?.type === "text" && SCRIPT_HEADER.test(first.text);
		const content = hasHeader ? rest : result.content;
		const output = options.isPartial
			? ""
			: getTextOutput({ ...result, content }, context.showImages).trim();
		if (output) {
			const color = context.isError ? "error" : "toolOutput";
			const styled = replaceTabs(output)
				.split("\n")
				.map((line) => theme.fg(color, line))
				.join("\n");
			component.addChild(new Spacer(1));
			if (options.expanded) {
				component.addChild(new Text(styled, 0, 0));
			} else {
				component.addChild(
					new VisualLinePreview({
						text: styled,
						maxVisualLines: OUTPUT_PREVIEW_LINES,
						keep: "start",
						formatHint: (hidden) => expandHint(theme, `${hidden} more lines`),
					}),
				);

				const fullOutputPath = result.details?.fullOutputPath;
				if (fullOutputPath) {
					const label = theme.fg("muted", `Full output: ${fullOutputPath}`);
					component.addChild(new Text(label, 0, 0));
				}
			}
		}
		return component;
	},
};
