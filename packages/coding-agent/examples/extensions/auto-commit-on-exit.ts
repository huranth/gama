import type { ExtensionAPI } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	gama.on("session_shutdown", async (_event, ctx) => {
		const { stdout: status, code } = await gama.exec("git", ["status", "--porcelain"]);

		if (code !== 0 || status.trim().length === 0) {
			return;
		}

		const entries = ctx.sessionManager.getEntries();
		let lastAssistantText = "";
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = entry.message.content;
				if (Array.isArray(content)) {
					lastAssistantText = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				}
				break;
			}
		}

		const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
		const commitMessage = `[gama] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

		await gama.exec("git", ["add", "-A"]);
		const { code: commitCode } = await gama.exec("git", ["commit", "-m", commitMessage]);

		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
		}
	});
}
