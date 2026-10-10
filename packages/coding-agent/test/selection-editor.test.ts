import { Editor, Text, TuiAltScreen, VStack } from "@huranth/gama-tui";
import { describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createChatViewport } from "../src/modes/tui/chat-viewport.ts";
import { CenteredColumn } from "../src/modes/tui/parts/centered-column.ts";

describe("fullscreen editor selection", () => {
	it("deletes selected editor text with backspace through a centered column", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		const column = new CenteredColumn(30);
		column.addChild(editor);
		tui.setLayoutRoot(
			new VStack([{ component: column }, { component: new Text("footer", 0, 0) }]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;6;2M");
		terminal.sendInput("\x1b[<32;10;2M");
		terminal.sendInput("\x1b[<0;10;2m");
		await terminal.waitForRender();
		expect(tui.hasActiveSelection()).toBe(true);

		terminal.sendInput("\x7f");
		await terminal.waitForRender();

		expect(editor.getText()).toBe(" world");
		expect(tui.hasActiveSelection()).toBe(false);
		tui.stop();
	});

	it("copies only the visible text when the drag starts in the centered margin", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("asdadada        asda");
		const column = new CenteredColumn(30);
		column.addChild(editor);
		tui.setLayoutRoot(
			new VStack([{ component: column }, { component: new Text("footer", 0, 0) }]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;25;2M");
		terminal.sendInput("\x1b[<0;25;2m");
		await terminal.waitForRender();

		expect(tui.hasActiveSelection()).toBe(true);
		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.at(-1)).toEqual("asdadada        asda");
		tui.stop();
	});

	it("copies leading and trailing spaces inside the selection", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("  hi  ");
		const column = new CenteredColumn(30);
		column.addChild(editor);
		tui.setLayoutRoot(
			new VStack([{ component: column }, { component: new Text("footer", 0, 0) }]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;11;2M");
		terminal.sendInput("\x1b[<0;11;2m");
		await terminal.waitForRender();

		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.at(-1)).toEqual("  hi  ");
		tui.stop();
	});

	it("keeps typed trailing spaces when the drag passes the text", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hi  ");
		const column = new CenteredColumn(30);
		column.addChild(editor);
		tui.setLayoutRoot(
			new VStack([{ component: column }, { component: new Text("footer", 0, 0) }]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;20;2M");
		terminal.sendInput("\x1b[<0;20;2m");
		await terminal.waitForRender();

		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.at(-1)).toEqual("hi  ");
		tui.stop();
	});

	it("does not move the editor cursor when clicking in chat", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		const column = new CenteredColumn(30);
		column.addChild(editor);
		tui.setLayoutRoot(
			new VStack([{ component: new Text("chat line", 0, 0) }, { component: column }]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		const before = editor.getCursor();
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;3;1M");
		terminal.sendInput("\x1b[<0;3;1m");
		await terminal.waitForRender();

		expect(editor.getCursor()).toEqual(before);
		expect(tui.hasActiveSelection()).toBe(false);
		tui.stop();
	});

	it("strips borders from chat content", async () => {
		const terminal = new VirtualTerminal(30, 10);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		const transcript = new CenteredColumn(30);
		transcript.addChild(new Text("│ hello │", 0, 0));
		const editorColumn = new CenteredColumn(30);
		editorColumn.addChild(editor);
		const viewport = createChatViewport({
			document: transcript,
			pendingMessages: new Text("", 0, 0),
			status: new Text("", 0, 0),
			editor: editorColumn,
			footer: new Text("footer", 0, 0),
		});
		tui.setLayoutRoot(viewport.root);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;9;1M");
		terminal.sendInput("\x1b[<0;9;1m");
		await terminal.waitForRender();

		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.at(-1)).toEqual("hello");
		tui.stop();
	});

	it("does not copy an editor border when the selection crosses it", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		const column = new CenteredColumn(30);
		column.addChild(editor);
		tui.setLayoutRoot(
			new VStack([{ component: new Text("chat line", 0, 0) }, { component: column }]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;10;3M");
		terminal.sendInput("\x1b[<0;10;3m");
		await terminal.waitForRender();

		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.at(-1)).toEqual("hello");
		tui.stop();
	});

	it("skips border-only rows in chat content", async () => {
		const terminal = new VirtualTerminal(30, 10);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		const transcript = new CenteredColumn(30);
		transcript.addChild(new Text("────────────\nhello\n────────────", 0, 0));
		const editorColumn = new CenteredColumn(30);
		editorColumn.addChild(editor);
		const viewport = createChatViewport({
			document: transcript,
			pendingMessages: new Text("", 0, 0),
			status: new Text("", 0, 0),
			editor: editorColumn,
			footer: new Text("footer", 0, 0),
		});
		tui.setLayoutRoot(viewport.root);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;12;3M");
		terminal.sendInput("\x1b[<0;12;3m");
		await terminal.waitForRender();

		expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
		expect(copied.at(-1)).toEqual("hello");
		tui.stop();
	});

	it("does not move the editor cursor when clicking through the chat viewport", async () => {
		const terminal = new VirtualTerminal(40, 12);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		const transcript = new CenteredColumn(30);
		transcript.addChild(new Text("chat line\nsecond line", 0, 0));
		const editorColumn = new CenteredColumn(30);
		editorColumn.addChild(editor);
		const viewport = createChatViewport({
			document: transcript,
			pendingMessages: new Text("", 0, 0),
			status: new Text("", 0, 0),
			editor: editorColumn,
			footer: new Text("footer", 0, 0),
		});
		tui.setLayoutRoot(viewport.root);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		const before = editor.getCursor();
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();

		expect(editor.getCursor()).toEqual(before);
		tui.stop();
	});
});
