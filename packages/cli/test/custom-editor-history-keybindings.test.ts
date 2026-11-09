import { setKeybindings, MainScreen } from "@huranth/gama-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../ui/test/test-themes.ts";
import { VirtualTerminal } from "../../ui/test/virtual-terminal.ts";
import { Keymap } from "../src/core/hotkeys.ts";
import { CustomEditor } from "../src/term/parts/custom-editor.ts";

afterEach(() => {
	setKeybindings(new Keymap());
});

describe("CustomEditor prompt history keybindings", () => {
	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new Keymap({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(
			new MainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			keybindings,
		);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10");
		expect(editor.getText()).toBe("previous prompt");
		expect(modelCycles).toBe(0);

		editor.handleInput("\x0e");
		expect(editor.getText()).toBe("draft");
	});
});
