import { Container, Spacer, Text } from "@huranth/gama-tui";
import { keyHint } from "../../../modes/tui/parts/keybinding-hints.ts";
import { VisualLinePreview } from "../../../modes/tui/parts/visual-truncate.ts";
import { theme } from "../../../modes/tui/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = 5;

export const BASH_UPDATE_THROTTLE_MS = 100;

type ShellArgs = { command?: string; timeout?: number } | undefined;

type ShellRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
	sawPartial?: boolean;
};

type BashResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: BashToolDetails;
};

export function createShellRenderers(
	prompt: string,
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			const state = context.state as ShellRenderState;

			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatShellCall(args as ShellArgs, prompt));

			return text;
		},

		renderResult(result, options, _theme, context) {
			const state = context.state as ShellRenderState;

			if (options.isPartial) state.sawPartial = true;

			const ticking = state.startedAt !== undefined && options.isPartial;
			if (ticking && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}

			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				stopTicking(state);
			}

			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuildShellResult(component, result as BashResult, options, context.showImages, state);
			component.invalidate();

			return component;
		},
	};
}

function stopTicking(state: ShellRenderState): void {
	if (!state.interval) return;

	clearInterval(state.interval);
	state.interval = undefined;
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m ${remainder}s`;
}

function formatShellCall(args: ShellArgs, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

	let commandDisplay = theme.fg("toolOutput", "...");
	if (command === null) commandDisplay = invalidArgText(theme);
	else if (command) commandDisplay = command;

	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}

function styleLine(line: string): string {
	return theme.fg("toolOutput", line);
}

function formatHiddenHint(hidden: number): string {
	const prefix = theme.fg("muted", `... (${hidden} earlier lines, `);
	const expand = keyHint("app.tools.expand", "to expand");

	return prefix + expand + theme.fg("muted", ")");
}

function getDisplayOutput(
	result: BashResult,
	options: ToolRenderResultOptions,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	const path = result.details?.fullOutputPath;
	const truncated = result.details?.truncation?.truncated;

	if (options.isPartial || !truncated || !path || !output.endsWith("]")) return output;

	const footerStart = output.lastIndexOf("\n\n[");
	const footer = footerStart === -1 ? "" : output.slice(footerStart);
	if (!footer.includes(path)) return output;

	return output.slice(0, footerStart).trimEnd();
}

function addOutput(component: Container, output: string, expanded: boolean): void {
	const styled = output.split("\n").map(styleLine).join("\n");

	if (expanded) {
		component.addChild(new Text(`\n${styled}`, 0, 0));
		return;
	}

	component.addChild(new Spacer(1));
	component.addChild(
		new VisualLinePreview({
			text: styled,
			maxVisualLines: BASH_PREVIEW_LINES,
			keep: "end",
			formatHint: formatHiddenHint,
		}),
	);
}

function formatWarnings(result: BashResult): string | undefined {
	const warnings: string[] = [];
	const path = result.details?.fullOutputPath;
	const truncation = result.details?.truncation;

	if (path) warnings.push(`Full output: ${path}`);

	if (truncation?.truncated) {
		if (truncation.truncatedBy === "lines") {
			const counts = `${truncation.outputLines} of ${truncation.totalLines} lines`;
			warnings.push(`Truncated: showing ${counts}`);
		} else {
			const size = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
			warnings.push(`Truncated: ${truncation.outputLines} lines shown (${size} limit)`);
		}
	}

	if (warnings.length === 0) return undefined;

	return theme.fg("warning", `[${warnings.join(". ")}]`);
}

function formatElapsed(
	state: ShellRenderState,
	options: ToolRenderResultOptions,
): string | undefined {
	const startedAt = state.startedAt;
	if (startedAt === undefined) return undefined;
	if (!options.isPartial && !state.sawPartial) return undefined;

	const label = options.isPartial ? "Elapsed" : "Took";
	const endTime = state.endedAt ?? Date.now();

	return theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`);
}

function rebuildShellResult(
	component: Container,
	result: BashResult,
	options: ToolRenderResultOptions,
	showImages: boolean,
	state: ShellRenderState,
): void {
	component.clear();

	const output = getDisplayOutput(result, options, showImages);
	if (output) addOutput(component, output, options.expanded);

	const warnings = formatWarnings(result);
	if (warnings) component.addChild(new Text(`\n${warnings}`, 0, 0));

	const elapsed = formatElapsed(state, options);
	if (elapsed) component.addChild(new Text(`\n${elapsed}`, 0, 0));
}
