import type { ExtensionAPI } from "@huranth/gama-harness";
import { Type } from "typebox";

export default function (gama: ExtensionAPI) {
	gama.registerCommand("quit", {
		description: "Exit gama cleanly",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});

	gama.registerTool({
		name: "finish_and_exit",
		label: "Finish and Exit",
		description: "Complete a task and exit gama",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ctx.shutdown();

			return {
				content: [{ type: "text", text: "Shutdown requested. Exiting after this response." }],
				details: {},
			};
		},
	});

	gama.registerTool({
		name: "deploy_and_exit",
		label: "Deploy and Exit",
		description: "Deploy the application and exit gama",
		parameters: Type.Object({
			environment: Type.String({
				description: "Target environment (e.g., production, staging)",
			}),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			onUpdate?.({
				content: [{ type: "text", text: `Deploying to ${params.environment}...` }],
				details: {},
			});

			onUpdate?.({
				content: [{ type: "text", text: "Deployment complete, exiting..." }],
				details: {},
			});
			ctx.shutdown();

			return {
				content: [{ type: "text", text: "Done! Shutdown requested." }],
				details: { environment: params.environment },
			};
		},
	});
}
