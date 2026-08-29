import type { ProviderClassifier } from "../types.ts";

export const cloudflareWorkersAISystemOneApi = (): ProviderClassifier => ({
	classify: async (model, context, options) => {
		const module = await import("./cloudflare-workers-ai-system-one.ts");

		return module.classify(model, context, options);
	},
});
