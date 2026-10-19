import type { ExtensionAPI, ExtensionContext } from "@huranth/gama-harness";

const DEFAULT_LABEL = "Pondering...";

export default function (gama: ExtensionAPI) {
	let label = DEFAULT_LABEL;

	const applyLabel = (ctx: ExtensionContext) => {
		ctx.ui.setHiddenThinkingLabel(label);
	};

	gama.on("session_start", async (_event, ctx) => {
		applyLabel(ctx);
	});

	gama.registerCommand("thinking-label", {
		description: "Set the hidden thinking label. Use without args to reset.",
		handler: async (args, ctx) => {
			const nextLabel = args.trim();

			if (!nextLabel) {
				label = DEFAULT_LABEL;
				ctx.ui.setHiddenThinkingLabel();
				ctx.ui.notify(`Hidden thinking label reset to: ${DEFAULT_LABEL}`);
				return;
			}

			label = nextLabel;
			ctx.ui.setHiddenThinkingLabel(label);
			ctx.ui.notify(`Hidden thinking label set to: ${label}`);
		},
	});
}
