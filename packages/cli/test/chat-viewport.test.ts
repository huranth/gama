import { Container, Text } from "@huranth/gama-tui";
import { describe, expect, test } from "vitest";
import { renderLayoutFrame } from "../../ui/src/layout.ts";
import { createChatViewport } from "../src/term/viewport.ts";

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("keeps a blank line between the editor area and the footer", () => {
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Text("editor\nline two\nline three", 0, 0),
			footer: new Text("footer", 0, 0),
		});

		const lines = viewport.root.render(80).map((line) => line.trim());
		const editorIndex = lines.indexOf("line three");
		const footerIndex = lines.indexOf("footer");

		expect(editorIndex).toBeGreaterThanOrEqual(0);
		expect(footerIndex).toBeGreaterThan(editorIndex);
		expect(lines.slice(editorIndex + 1, footerIndex)).toEqual([""]);
	});

	test("keeps the blank line when a short window squeezes the dock", () => {
		const editorLines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Text(editorLines.join("\n"), 0, 0),
			footer: new Text("footer", 0, 0),
		});

		const lines = renderLayoutFrame(viewport.root, 80, 12, () => {}).lines.map((line) =>
			line.trim(),
		);
		const footerIndex = lines.indexOf("footer");

		expect(footerIndex).toBe(11);
		expect(lines[footerIndex - 1]).toBe("");
		expect(lines[footerIndex - 2]).toBe("line 9");
	});
});
