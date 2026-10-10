import type { Component, TUI } from "@huranth/gama-tui";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ActivityLineComponent } from "../src/modes/tui/parts/activity.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";

const command = [
	"printf 'export const x = missingSymbol + 1;\\n' > /tmp/undef.ts",
	"npx tsc --noEmit --strict /tmp/undef.ts 2>&1 | tail -n 5",
	'echo "exit=$?"',
].join("\n");

const output = "=== 1: self-SIGKILL, reported through the shell ===\nnode exited with 1\nexit=1";

function failedBashCard(): ActivityLineComponent {
	const card = new ActivityLineComponent({
		record: {
			toolCallId: "failed-bash",
			name: "bash",
			args: { command },
			status: "error",
			timestamp: Date.now() - 30_000,
			result: { content: [{ type: "text", text: output }] },
		},
	});
	card.setExpanded(true);
	return card;
}

async function renderCard(width: number, height: number) {
	const terminal = new VirtualTerminal(width, height);
	const tui: TUI = new TuiMainScreen(terminal);
	tui.addChild(new Wrapper(failedBashCard()));
	tui.start();
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
	return { terminal, tui };
}

function rowsOf(terminal: VirtualTerminal): Array<{ text: string; struck: number[] }> {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const rows: Array<{ text: string; struck: number[] }> = [];
	for (let row = 0; row < terminal.rows; row++) {
		const line = buffer.getLine(buffer.viewportY + row);
		let text = "";
		const struck: number[] = [];
		for (let column = 0; column < terminal.columns; column++) {
			const cell = line?.getCell(column);
			text += cell?.getChars() || " ";
			if (cell?.isStrikethrough()) struck.push(column);
		}
		rows.push({ text, struck });
	}
	return rows;
}

function lastTextColumn(text: string): number {
	return text.trimEnd().length - 1;
}

class Wrapper implements Component {
	private readonly inner: Component;

	constructor(inner: Component) {
		this.inner = inner;
	}

	render(width: number): string[] {
		return this.inner.render(width);
	}

	invalidate(): void {}
}
describe("failed command card", () => {
	initTheme("dark");

	it("says the command failed instead of reading as a pass", async () => {
		const { terminal, tui } = await renderCard(80, 30);
		const screen = rowsOf(terminal)
			.map((row) => row.text)
			.join("\n");

		expect(screen).toContain("failed to run");
		tui.stop();
	});

	it("never strikes the card fill past the command text", async () => {
		const { terminal, tui } = await renderCard(80, 30);

		for (const row of rowsOf(terminal)) {
			expect(row.struck.every((column) => column <= lastTextColumn(row.text))).toBe(true);
		}

		tui.stop();
	});

	it("keeps the strike on the command rows only", async () => {
		const { terminal, tui } = await renderCard(80, 30);
		const rows = rowsOf(terminal);

		const commandRows = rows.filter((row) => row.text.includes("printf 'export const"));
		const outputRows = rows.filter(
			(row) => row.text.includes("node exited with 1") || row.text.includes("self-SIGKILL"),
		);

		expect(commandRows.length).toBeGreaterThan(0);
		expect(commandRows.every((row) => row.struck.length > 0)).toBe(true);
		expect(outputRows.length).toBeGreaterThan(0);
		expect(outputRows.every((row) => row.struck.length === 0)).toBe(true);

		tui.stop();
	});
});
