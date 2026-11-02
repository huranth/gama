import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../src/screen.ts";
import { MainScreen } from "../src/main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class ClickTarget implements Component {
	presses = 0;
	clicks = 0;
	wheels: number[] = [];

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		if (event.type === "press") this.presses += 1;
		if (event.type === "click") this.clicks += 1;
		if (event.type === "wheel") this.wheels.push(event.wheelDelta ?? 0);
		return { handled: true };
	}

	invalidate(): void {}

	render(): string[] {
		return ["target"];
	}
}

async function createScreen(): Promise<{
	terminal: VirtualTerminal;
	tui: MainScreen;
	target: ClickTarget;
}> {
	const terminal = new VirtualTerminal(40, 10);
	const tui = new MainScreen(terminal);
	const target = new ClickTarget();

	tui.addChild(target);
	tui.start();
	await terminal.waitForRender();
	tui.setMouseTracking(true);
	return { terminal, tui, target };
}

describe("MainScreen mouse", () => {
	it("turns a press and release into a click", async () => {
		const { terminal, tui, target } = await createScreen();

		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<0;3;1m");

		assert.strictEqual(target.presses, 1);
		assert.strictEqual(target.clicks, 1);
		tui.stop();
	});

	it("ignores a release that moved away from the press", async () => {
		const { terminal, tui, target } = await createScreen();

		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<0;5;1m");

		assert.strictEqual(target.presses, 1);
		assert.strictEqual(target.clicks, 0);
		tui.stop();
	});

	it("reports wheel direction", async () => {
		const { terminal, tui, target } = await createScreen();

		terminal.sendInput("\x1b[<64;3;1M");
		terminal.sendInput("\x1b[<65;3;1M");

		assert.deepStrictEqual(target.wheels, [-1, 1]);
		tui.stop();
	});

	it("ignores a click on an overlay that was closed before the next render", async () => {
		const { terminal, tui, target } = await createScreen();
		const overlay = new ClickTarget();

		tui.showOverlay(overlay, { row: 0, col: 0, width: 20 });
		await terminal.waitForRender();
		tui.hideOverlay();

		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<0;3;1m");

		assert.strictEqual(overlay.presses, 0);
		assert.strictEqual(target.presses, 1);
		tui.stop();
	});
});
