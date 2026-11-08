import type { ExtensionAPI } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	let turnCount = 0;

	gama.on("session_start", async (event, ctx) => {
		ctx.ui.setTitle(event.reason === "new" ? "gama RPC Demo (new session)" : "gama RPC Demo");
		ctx.ui.setWidget("rpc-demo", ["--- RPC Extension UI Demo ---", "Loaded and ready."]);
		ctx.ui.setStatus("rpc-demo", `Turns: ${turnCount}`);
	});

	gama.on("turn_start", async (_event, ctx) => {
		turnCount++;
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} running...`);
	});

	gama.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} done`);
	});

	gama.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = /\brm\s+(-rf?|--recursive)/i.test(command) || /\bsudo\b/i.test(command);

		if (isDangerous) {
			if (!ctx.hasUI) {
				return { block: true, reason: "Dangerous command blocked (no UI)" };
			}

			const choice = await ctx.ui.select(`Dangerous command: ${command}`, ["Allow", "Block"]);
			if (choice !== "Allow") {
				ctx.ui.notify("Command blocked by user", "warning");
				return { block: true, reason: "Blocked by user" };
			}
			ctx.ui.notify("Command allowed", "info");
		}

		return undefined;
	});

	gama.on("session_before_switch", async (event, ctx) => {
		if (event.reason !== "new") return;
		if (!ctx.hasUI) return;

		const confirmed = await ctx.ui.confirm("Clear session?", "All messages will be lost.");
		if (!confirmed) {
			ctx.ui.notify("Clear cancelled", "info");
			return { cancel: true };
		}
	});

	gama.registerCommand("rpc-input", {
		description: "Prompt for text input (demonstrates ctx.ui.input in RPC)",
		handler: async (_args, ctx) => {
			const value = await ctx.ui.input("Enter a value", "type something...");
			if (value) {
				ctx.ui.notify(`You entered: ${value}`, "info");
			} else {
				ctx.ui.notify("Input cancelled", "info");
			}
		},
	});

	gama.registerCommand("rpc-editor", {
		description: "Open multi-line editor (demonstrates ctx.ui.editor in RPC)",
		handler: async (_args, ctx) => {
			const text = await ctx.ui.editor("Edit some text", "Line 1\nLine 2\nLine 3");
			if (text) {
				ctx.ui.notify(`Editor submitted (${text.split("\n").length} lines)`, "info");
			} else {
				ctx.ui.notify("Editor cancelled", "info");
			}
		},
	});

	gama.registerCommand("rpc-prefill", {
		description: "Prefill the input editor (demonstrates ctx.ui.setEditorText in RPC)",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("This text was set by the rpc-demo extension.");
			ctx.ui.notify("Editor prefilled", "info");
		},
	});
}
