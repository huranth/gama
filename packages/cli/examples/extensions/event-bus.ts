import type { ExtensionAPI, ExtensionContext } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;

	gama.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
	});

	gama.events.on("my:notification", (data) => {
		const { message, from } = data as { message: string; from: string };
		currentCtx?.ui.notify(`Event from ${from}: ${message}`, "info");
	});

	gama.registerCommand("emit", {
		description: "Emit my:notification event (usage: /emit message)",
		handler: async (args, _ctx) => {
			const message = args.trim() || "hello";
			gama.events.emit("my:notification", { message, from: "/emit command" });
		},
	});

	gama.on("session_start", async () => {
		gama.events.emit("my:notification", {
			message: "Session started",
			from: "event-bus-example",
		});
	});
}
