import { visibleWidth } from "@huranth/gama-tui";
import chalk from "chalk";
import { beforeAll, describe, expect, it } from "vitest";
import { truncateTail } from "../src/core/tools/truncate.ts";
import { BashExecutionComponent } from "../src/modes/tui/parts/bash-execution.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createTuiStub(columns: number): { columns: number; stub: any } {
	const state = { columns };
	const stub = {
		terminal: {
			get columns() {
				return state.columns;
			},
			get rows() {
				return 24;
			},
		},
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
	return { columns: state.columns, stub };
}

describe("BashExecutionComponent width handling (#2569)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("collapsed preview lines respect render-time width, " + "not construction-time width", () => {
		const wideWidth = 200;
		const narrowWidth = 80;

		const { stub } = createTuiStub(wideWidth);
		const component = new BashExecutionComponent("pwd", stub);

		const longLine = "x".repeat(150);
		component.appendOutput(`${longLine}\n${longLine}\n`);

		component.setComplete(0, false);

		const lines = component.render(narrowWidth);

		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > ${narrowWidth}`).toBeLessThanOrEqual(narrowWidth);
		}
	});

	it("re-computes lines when width changes between renders", () => {
		const { stub } = createTuiStub(200);
		const component = new BashExecutionComponent("echo hello", stub);

		const longLine = "abcdefghij".repeat(20);
		component.appendOutput(`${longLine}\n`);
		component.setComplete(0, false);

		const lines200 = component.render(200);
		for (const line of lines200) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(200);
		}

		const lines60 = component.render(60);
		for (let i = 0; i < lines60.length; i++) {
			const w = visibleWidth(lines60[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 60`).toBeLessThanOrEqual(60);
		}
	});

	it("renders a bordered command panel with bold header and streams output", () => {
		const previousLevel = chalk.level;
		chalk.level = 3;
		try {
			const { stub } = createTuiStub(80);
			const component = new BashExecutionComponent("echo hello", stub);
			const initial = component.render(80).join("\n");
			expect(stripAnsi(initial)).toContain("$ echo hello");
			expect(stripAnsi(initial)).not.toContain("Running...");

			component.appendOutput("first\r\nsec");
			component.appendOutput("ond\n");
			const running = component.render(80).join("\n");
			expect(stripAnsi(running)).toMatch(/first\s+second/);
			expect(component.getOutput()).toBe("first\nsecond\n");
			expect(running).toMatch(/\x1b\[1m/);
			expect(stripAnsi(running)).toContain("─");

			component.setComplete(0, false);
			expect(stripAnsi(component.render(80).join("\n"))).not.toContain("Running...");
		} finally {
			chalk.level = previousLevel;
		}
	});

	it(
		"keeps cancellation, failures, and truncation visible as " + "text within narrow widths",
		() => {
			const { stub } = createTuiStub(80);
			const cancelled = new BashExecutionComponent("long command", stub);
			cancelled.setComplete(undefined, true);
			expect(stripAnsi(cancelled.render(24).join("\n"))).toContain("Cancelled");

			const failed = new BashExecutionComponent("echo failure", stub, true);
			failed.appendOutput("failed output\n");
			failed.setComplete(
				7,
				false,
				truncateTail("some long output", { maxBytes: 4 }),
				"/tmp/full-output.log",
			);
			const lines = failed.render(24);
			const text = stripAnsi(lines.join("\n"));
			expect(text).toContain("$ echo failure");
			expect(text).toContain("failed output");
			expect(text).toContain("Failed");
			expect(text.replace(/\s+/g, "")).toContain(
				"Outputtruncated,fulloutputat/tmp/full-output.log",
			);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(24);
			}
		},
	);

	it(
		"expands and collapses hidden output via setExpanded " + "without losing the width bound",
		() => {
			const { stub } = createTuiStub(80);
			const component = new BashExecutionComponent("echo entries", stub);
			component.appendOutput(
				Array.from(
					{ length: 25 },
					(_, index) => `entry-${String(index).padStart(2, "0")}`,
				).join("\n"),
			);
			component.setComplete(0, false);

			const width = 32;
			const collapsed = component.render(width);
			expect(stripAnsi(collapsed.join("\n"))).not.toContain("entry-00");
			expect(stripAnsi(collapsed.join("\n"))).toContain("expand");
			component.setExpanded(true);
			const expanded = component.render(width);
			expect(stripAnsi(expanded.join("\n"))).toContain("entry-00");
			for (const line of expanded) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			component.setExpanded(false);
			expect(stripAnsi(component.render(width).join("\n"))).not.toContain("entry-00");
		},
	);
});
