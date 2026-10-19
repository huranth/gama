import type { ExtensionAPI } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	gama.on("model_select", async (event, ctx) => {
		const { model, previousModel, source } = event;

		const next = `${model.provider}/${model.id}`;
		const prev = previousModel ? `${previousModel.provider}/${previousModel.id}` : "none";

		if (source !== "restore") {
			ctx.ui.notify(`Model: ${next}`, "info");
		}

		ctx.ui.setStatus("model", model.id);

		console.log(`[model_select] ${prev} → ${next} (${source})`);
	});
}
