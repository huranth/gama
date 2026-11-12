import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	let watcher: fs.FSWatcher | undefined;

	gama.on("session_start", async (_event, ctx) => {
		const triggerFile = join(tmpdir(), "agent-trigger.txt");

		// Create the file first so the watch always has something to attach to
		if (!fs.existsSync(triggerFile)) fs.writeFileSync(triggerFile, "");

		watcher?.close();
		watcher = fs.watch(triggerFile, () => {
			try {
				const content = fs.readFileSync(triggerFile, "utf-8").trim();
				if (content) {
					gama.sendMessage(
						{
							customType: "file-trigger",
							content: `External trigger: ${content}`,
							display: true,
						},
						{ triggerTurn: true },
					);
					fs.writeFileSync(triggerFile, "");
				}
			} catch {}
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`Watching ${triggerFile}`, "info");
		}
	});

	gama.on("session_shutdown", () => {
		watcher?.close();
		watcher = undefined;
	});
}
