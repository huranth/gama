import { setKeybindings, type TUI } from "@huranth/gama-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Keymap } from "../src/core/hotkeys.ts";
import { BorderedLoader } from "../src/term/parts/bordered-loader.ts";
import { initTheme, theme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = { requestRender: () => {} } as unknown as TUI;

function render(loader: BorderedLoader): string {
	return stripAnsi(loader.render(80).join("\n"));
}

describe("BorderedLoader", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new Keymap());
	});

	test("shows the cancel hint by default", () => {
		const loader = new BorderedLoader(ui, theme, "Fetching models…");

		const output = render(loader);

		expect(output).toContain("Fetching models…");
		expect(output).toContain("cancel");
		loader.dispose();
	});

	test("hides the cancel hint when asked", () => {
		const loader = new BorderedLoader(ui, theme, "Fetching models…", {
			showCancelHint: false,
		});

		const output = render(loader);

		expect(output).toContain("Fetching models…");
		expect(output).not.toContain("cancel");
		loader.dispose();
	});

	test("hides the borders when asked", () => {
		const loader = new BorderedLoader(ui, theme, "Fetching models…", {
			showBorders: false,
		});

		const output = render(loader);

		expect(output).toContain("Fetching models…");
		expect(output).not.toContain("─");
		loader.dispose();
	});
});
