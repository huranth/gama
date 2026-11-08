import type { ExtensionAPI } from "@huranth/gama-harness";

const TRIGGER = /\b(changes?|diff|modified)\b/i;

export default function (gama: ExtensionAPI) {
	gama.on("input", async (event) => {
		if (event.streamingBehavior === "steer") {
			return { action: "continue" };
		}

		if (!TRIGGER.test(event.text)) {
			return { action: "continue" };
		}

		const { stdout, code } = await gama.exec("git", ["diff", "--stat"]);
		if (code !== 0 || !stdout.trim()) {
			return { action: "continue" };
		}

		return {
			action: "transform",
			text: `${event.text}\n\nCurrent uncommitted changes:\n\`\`\`\n${stdout.trim()}\n\`\`\``,
		};
	});
}
