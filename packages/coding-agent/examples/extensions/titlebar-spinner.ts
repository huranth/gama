import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@huranth/gama-harness";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(gama: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = gama.getSessionName();
	return session ? `γ - ${session} - ${cwd}` : `γ - ${cwd}`;
}

export default function (gama: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(gama));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = gama.getSessionName();
			const title = session ? `${frame} γ - ${session} - ${cwd}` : `${frame} γ - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	gama.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	gama.on("agent_settled", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	gama.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
