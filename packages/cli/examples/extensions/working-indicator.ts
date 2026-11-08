import type {
	ExtensionAPI,
	ExtensionContext,
	WorkingIndicatorOptions,
} from "@huranth/gama-harness";

type WorkingIndicatorMode = "dot" | "none" | "pulse" | "spinner" | "default";

const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const HIDDEN_INDICATOR: WorkingIndicatorOptions = {
	frames: [],
};

function getIndicator(
	mode: WorkingIndicatorMode,
	accent: (text: string) => string,
): WorkingIndicatorOptions | undefined {
	switch (mode) {
		case "dot":
			return { frames: [accent("*")] };
		case "none":
			return HIDDEN_INDICATOR;
		case "pulse":
			return {
				frames: [accent("."), accent(":"), accent("*"), accent(":")],
				intervalMs: 120,
			};
		case "spinner":
			return {
				frames: SPINNER_FRAMES.map((frame) => accent(frame)),
				intervalMs: 80,
			};
		case "default":
			return undefined;
	}
}

function describeMode(mode: WorkingIndicatorMode): string {
	switch (mode) {
		case "dot":
			return "static dot";
		case "none":
			return "hidden";
		case "pulse":
			return "custom pulse";
		case "spinner":
			return "custom spinner";
		case "default":
			return "gama default spinner";
	}
}

export default function (gama: ExtensionAPI) {
	let mode: WorkingIndicatorMode = "spinner";

	const applyIndicator = (ctx: ExtensionContext) => {
		ctx.ui.setWorkingIndicator(getIndicator(mode, (text) => ctx.ui.theme.fg("accent", text)));
		ctx.ui.setStatus(
			"working-indicator",
			ctx.ui.theme.fg("dim", `Indicator: ${describeMode(mode)}`),
		);
	};

	gama.on("session_start", async (_event, ctx) => {
		applyIndicator(ctx);
	});

	gama.registerCommand("working-indicator", {
		description: "Set the streaming working indicator: dot, pulse, none, spinner, or reset.",
		handler: async (args, ctx) => {
			const nextMode = args.trim().toLowerCase();
			if (!nextMode) {
				ctx.ui.notify(`Working indicator: ${describeMode(mode)}`, "info");
				return;
			}

			if (
				nextMode !== "dot" &&
				nextMode !== "none" &&
				nextMode !== "pulse" &&
				nextMode !== "spinner" &&
				nextMode !== "reset"
			) {
				ctx.ui.notify("Usage: /working-indicator [dot|pulse|none|spinner|reset]", "error");
				return;
			}

			mode = nextMode === "reset" ? "default" : nextMode;
			applyIndicator(ctx);
			ctx.ui.notify(`Working indicator set to: ${describeMode(mode)}`, "info");
		},
	});
}
