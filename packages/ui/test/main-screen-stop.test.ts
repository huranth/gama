import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/screen.ts";
import { MainScreen } from "../src/main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class StaticText implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override writeSync(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getOutput(): string {
		return this.writes.join("");
	}
}

function startTui(): { terminal: RecordingTerminal; tui: TUI } {
	const terminal = new RecordingTerminal(40, 10);
	const tui: TUI = new MainScreen(terminal);
	tui.addChild(new StaticText(["alpha", "beta"]));
	tui.start();
	tui.renderNow();
	return { terminal, tui };
}

function nextTick(): Promise<void> {
	return new Promise<void>((resolve) => process.nextTick(resolve));
}

describe("MainScreen stop", () => {
	it("clears the rendered frame when clearScreen is set", async () => {
		const { terminal, tui } = startTui();
		await terminal.flush();
		assert.ok(terminal.getViewport().some((line) => line.includes("alpha")));

		tui.stop({ clearScreen: true });
		await terminal.flush();

		assert.deepStrictEqual(
			terminal.getViewport(),
			Array(terminal.rows).fill(""),
			"the frame should be erased",
		);
		assert.deepStrictEqual(terminal.getCursorPosition(), { x: 0, y: 0 });

		const output = terminal.getOutput();
		const clearIndex = output.indexOf("\x1b[0J");
		assert.ok(clearIndex >= 0, "expected a clear-to-end-of-screen sequence");
		assert.ok(
			clearIndex > output.lastIndexOf("alpha"),
			"the frame should be cleared after it is drawn",
		);
	});

	it("keeps the frame when clearScreen is not set", async () => {
		const { terminal, tui } = startTui();

		tui.stop();
		await terminal.flush();

		assert.ok(
			terminal.getViewport().some((line) => line.includes("alpha")),
			"the frame should stay on screen",
		);
	});

	it("does not schedule a render before start", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new MainScreen(terminal);
		tui.addChild(new StaticText(["alpha"]));

		tui.requestRender();
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(!terminal.getOutput().includes("alpha"));

		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("alpha")));
		tui.stop();
	});

	it("clears a queued pre-start render on stop", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new MainScreen(terminal);
		tui.addChild(new StaticText(["alpha"]));

		tui.requestRender(true);
		tui.stop();
		await nextTick();

		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("alpha")));
		tui.stop();
	});

	it("does not enable mouse tracking before start", () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new MainScreen(terminal);

		tui.setMouseTracking(true);
		assert.ok(!terminal.getOutput().includes("\x1b[?1000h"));

		tui.stop();
		tui.start();
		assert.ok(terminal.getOutput().includes("\x1b[?1000h"));

		tui.stop();
		assert.ok(terminal.getOutput().includes("\x1b[?1006l"));
	});

	it("does not query terminal colors after stop", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new MainScreen(terminal);

		tui.start();
		tui.stop();
		const writes = terminal.writes.length;

		assert.deepStrictEqual(await tui.queryTerminalColors({ timeoutMs: 1000 }), {
			foreground: undefined,
			background: undefined,
			palette: undefined,
		});
		assert.strictEqual(terminal.writes.length, writes);
	});
});
