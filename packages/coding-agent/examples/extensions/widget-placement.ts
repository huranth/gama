import type { ExtensionAPI } from "@huranth/gama-harness";

export default function widgetPlacementExtension(gama: ExtensionAPI) {
	gama.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
