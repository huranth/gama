import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function struckColumns(terminal: VirtualTerminal, row: number): number[] {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const columns: number[] = [];
	for (let column = 0; column < terminal.columns; column++) {
		if (line.getCell(column)?.isStrikethrough()) columns.push(column);
	}
	return columns;
}

function underlinedColumns(terminal: VirtualTerminal, row: number): number[] {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const columns: number[] = [];
	for (let column = 0; column < terminal.columns; column++) {
		if (line.getCell(column)?.isUnderline()) columns.push(column);
	}
	return columns;
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI line padding", () => {
	it("keeps a strike out of the card fill after a failed command", async () => {
		const width = 40;
		const text = "  bash failed";
		const bg = "\x1b[48;2;51;44;45m";
		const line = `${bg}\x1b[9m${text}${" ".repeat(width - text.length)}\x1b[49m`;

		const terminal = new VirtualTerminal(width, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new StaticLines([line, "next row"]));
		tui.start();
		await renderAndFlush(tui, terminal);

		assert.deepStrictEqual(
			struckColumns(terminal, 0),
			Array.from({ length: text.length }, (_, i) => i),
		);
		assert.deepStrictEqual(struckColumns(terminal, 1), []);
		tui.stop();
	});

	it("keeps an underline out of the padding after a clipped link", async () => {
		const width = 30;
		const text = "/tmp/some/file.ts";
		const line = `\x1b[4m${text}${" ".repeat(width - text.length)}\x1b[24m`;

		const terminal = new VirtualTerminal(width, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new StaticLines([line]));
		tui.start();
		await renderAndFlush(tui, terminal);

		assert.deepStrictEqual(
			underlinedColumns(terminal, 0),
			Array.from({ length: text.length }, (_, i) => i),
		);
		tui.stop();
	});
});

class StaticLines implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}
