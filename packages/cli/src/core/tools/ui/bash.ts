import { Container, Spacer, Text } from "@huranth/gama-tui";
import { VisualLinePreview } from "../../../term/parts/visual-truncate.ts";
import type { Theme } from "../../../term/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../ext/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const SHELL_PREVIEW_LINES = 5;

const TICK_INTERVAL_MS = 1000;

const MS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

const MINUTES_PER_HOUR = 60;

// Footer marker
const FOOTER_PREFIX = "\n\n[";

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

function stopTicking(state: ShellRenderState): void {
	if (!state.interval) return;

	clearInterval(state.interval);
	state.interval = undefined;
}

function styleLine(line: string, theme: Theme): string {
	return theme.fg("toolOutput", line);
}

function formatHiddenHint(hidden: number, theme: Theme): string {
	return theme.fg("muted", `... (${hidden} earlier lines)`);
}

function formatDuration(ms: number): string {
	const seconds = ms / MS_PER_SECOND;
	if (seconds < SECONDS_PER_MINUTE) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
	const remainder = totalSeconds % SECONDS_PER_MINUTE;
	if (minutes < MINUTES_PER_HOUR) return `${minutes}m ${remainder}s`;

	const hours = Math.floor(minutes / MINUTES_PER_HOUR);

	return `${hours}h ${minutes % MINUTES_PER_HOUR}m ${remainder}s`;
}

function formatShellCall(args: ShellArgs, prompt: string, theme: Theme): string {
	const command = str(args?.command);
	const timeout = args?.timeout;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

	let commandDisplay = theme.fg("toolOutput", "...");
	if (command === null) commandDisplay = invalidArgText(theme);
	else if (command) commandDisplay = command;

	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
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

	const footerStart = output.lastIndexOf(FOOTER_PREFIX);
	const footer = footerStart === -1 ? "" : output.slice(footerStart);
	if (!footer.includes(path)) return output;

	return output.slice(0, footerStart).trimEnd();
}

function addOutput(component: Container, output: string, expanded: boolean, theme: Theme): void {
	const styled = output.split("\n").map((line) => styleLine(line, theme)).join("\n");

	if (expanded) {
		component.addChild(new Text(`\n${styled}`, 0, 0));
		return;
	}

	component.addChild(new Spacer(1));
	component.addChild(
		new VisualLinePreview({
			text: styled,
			maxVisualLines: SHELL_PREVIEW_LINES,
			keep: "end",
			formatHint: (hidden: number) => formatHiddenHint(hidden, theme),
		}),
	);
}

function formatWarnings(result: BashResult, theme: Theme): string | undefined {
	const warnings: string[] = [];
	const path = result.details?.fullOutputPath;
	const truncation = result.details?.truncation;

	if (path) warnings.push(`Full output: ${path}`);

	if (truncation?.truncated) {
		warnings.push(truncationWarning(truncation));
	}

	if (warnings.length === 0) return undefined;

	return theme.fg("warning", `[${warnings.join(". ")}]`);
}

function truncationWarning(truncation: NonNullable<BashToolDetails["truncation"]>): string {
	if (truncation.truncatedBy !== "lines") {
		const size = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);

		return `Truncated: ${truncation.outputLines} lines shown (${size} limit)`;
	}

	const counts = `${truncation.outputLines} of ${truncation.totalLines} lines`;

	return `Truncated: showing ${counts}`;
}

function formatElapsed(
	state: ShellRenderState,
	options: ToolRenderResultOptions,
	theme: Theme,
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
	theme: Theme,
): void {
	component.clear();

	const output = getDisplayOutput(result, options, showImages);
	if (output) addOutput(component, output, options.expanded, theme);

	const warnings = formatWarnings(result, theme);
	if (warnings) component.addChild(new Text(`\n${warnings}`, 0, 0));

	const elapsed = formatElapsed(state, options, theme);
	if (elapsed) component.addChild(new Text(`\n${elapsed}`, 0, 0));
}

export function createShellRenderers(
	prompt: string,
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, theme, context) {
			const state = context.state as ShellRenderState;

			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}

			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatShellCall(args as ShellArgs, prompt, theme));

			return text;
		},

		renderResult(result, options, theme, context) {
			const state = context.state as ShellRenderState;

			if (options.isPartial) state.sawPartial = true;

			const ticking = state.startedAt !== undefined && options.isPartial;
			if (ticking && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), TICK_INTERVAL_MS);
			}

			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				stopTicking(state);
			}

			const component =
				context.lastComponent instanceof Container ? context.lastComponent : new Container();

			rebuildShellResult(component, result as BashResult, options, context.showImages, state, theme);
			component.invalidate();

			return component;
		},
	};
}
