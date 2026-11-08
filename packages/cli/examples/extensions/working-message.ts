import type { ExtensionAPI } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	gama.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(ctx.ui.theme.fg("accent", "Working... (custom)"));
		ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "*")] });
	});
}
