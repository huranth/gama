import type { ExtensionAPI, Theme } from "@huranth/gama-harness";
import { VERSION } from "@huranth/gama-harness";

function getGamaMascot(theme: Theme): string[] {
	const gamaBlue = (text: string) => theme.fg("accent", text);
	const white = (text: string) => text;
	const black = (text: string) => theme.fg("dim", text);

	const BLOCK = "█";
	const PUPIL = "▌";

	const eye = `${white(BLOCK)}${black(PUPIL)}`;

	const lineEyes = `     ${eye}  ${eye}`;

	const lineBar = `  ${gamaBlue(BLOCK.repeat(14))}`;

	const lineLeg = `     ${gamaBlue(BLOCK.repeat(2))}    ${gamaBlue(BLOCK.repeat(2))}`;

	return ["", lineEyes, lineBar, lineLeg, lineLeg, lineLeg, lineLeg, ""];
}

export default function (gama: ExtensionAPI) {
	gama.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.setHeader((_tui, theme) => {
				return {
					render(_width: number): string[] {
						const mascotLines = getGamaMascot(theme);
						const subtitle = `${theme.fg("muted", "   gama coding agent")}${theme.fg("dim", ` v${VERSION}`)}`;
						return [...mascotLines, subtitle];
					},
					invalidate() {},
				};
			});
		}
	});

	gama.registerCommand("builtin-header", {
		description: "Restore built-in header with keybinding hints",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
