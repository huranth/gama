// Manual tool

import type { AssistantMessage } from "@huranth/gama-ai";
import { MainScreen, ProcessTerminal, type TUI } from "@huranth/gama-tui";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { AssistantMessageComponent } from "../src/term/parts/assistant-message.ts";
import { initTheme } from "../src/term/theme/theme.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

async function main() {
	process.env.COLORTERM = "truecolor";
	initTheme("dark");

	const fixtureMessage: AssistantMessage = JSON.parse(
		readFileSync(join(__dirname, "fixtures/assistant-message-with-thinking-code.json"), "utf-8"),
	);

	const thinkingContent = fixtureMessage.content.find((c) => c.type === "thinking");
	const textContent = fixtureMessage.content.find((c) => c.type === "text");

	if (!thinkingContent || thinkingContent.type !== "thinking") {
		console.error("No thinking content in fixture");
		process.exit(1);
	}

	const fullThinkingText = thinkingContent.thinking;
	const fullTextContent = textContent && textContent.type === "text" ? textContent.text : "";

	const terminal = new ProcessTerminal();
	const tui: TUI = new MainScreen(terminal);

	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "" }],
	} as AssistantMessage;

	const component = new AssistantMessageComponent(message, false);
	tui.addChild(component);
	tui.start();

	let thinkingBuffer = "";
	const chunkSize = 10;

	for (let i = 0; i < fullThinkingText.length; i += chunkSize) {
		thinkingBuffer += fullThinkingText.slice(i, i + chunkSize);

		const updatedMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: thinkingBuffer }],
		} as AssistantMessage;

		component.updateContent(updatedMessage);
		tui.requestRender();

		await sleep(15);
	}

	await sleep(500);

	const finalMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: fullThinkingText },
			{ type: "text", text: fullTextContent },
		],
	} as AssistantMessage;

	component.updateContent(finalMessage);
	tui.requestRender();

	await sleep(3000);

	tui.stop();
	process.exit(0);
}

const entry = process.argv[1];
const isEntry = entry !== undefined && resolve(entry) === __filename;

if (isEntry) {
	main().catch(console.error);
}
