import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Keymap, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { MainScreen } from "../src/main-screen.ts";
import { Editor } from "../src/view/editor.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	setKeybindings(new Keymap(TUI_KEYBINDINGS));
});

describe("Editor prompt history keybindings", () => {
	it("browses history directly without first moving the cursor", () => {
		setKeybindings(
			new Keymap(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = new Editor(new MainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older prompt");
		editor.addToHistory("newer\nmultiline prompt");
		editor.setText("draft");
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");

		editor.handleInput("\x10");
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });

		editor.handleInput("\x10");
		assert.strictEqual(editor.getText(), "older prompt");

		editor.handleInput("\x0e");
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		editor.handleInput("\x0e");
		assert.strictEqual(editor.getText(), "draft");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });
	});
});
