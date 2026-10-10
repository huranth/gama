import { setKeybindings, type TUI } from "@huranth/gama-tui";
import chalk from "chalk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/tui/parts/model-selector.ts";
import { initTheme, theme } from "../../../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function selectedModelId(selector: ModelSelectorComponent): string | undefined {
	const selectedBg = theme.getBgAnsi("selectedBg");
	const row = selector.render(120).find((line) => line.includes(selectedBg));
	if (!row) return undefined;

	return stripAnsi(row).trim();
}

describe("model selector filter resets selection to top", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		chalk.level = 3;
	});

	afterAll(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("moves selection to the first row in the All tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);

		const current = harness.getModel("alpha-1")!;
		const provider = current.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).not.toContain("Refreshing");
			expect(rendered).toContain("alpha-1");
		});

		for (const char of "alpha") {
			selector.handleInput(char);
		}
		expect(selectedModelId(selector)).toBe(`${provider}/alpha-1`);
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("beta-1");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		expect(selectedModelId(selector)).toBe(`${provider}/alpha-3`);

		selector.handleInput("l");
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(selectedModelId(selector)).toBe(`${provider}/alpha-1`);
		expect(rendered).not.toContain("beta-1");
	});

	it("moves selection to the first row in the Scoped tab when typing a query", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const alpha1 = harness.getModel("alpha-1")!;
		const alpha2 = harness.getModel("alpha-2")!;
		const alpha3 = harness.getModel("alpha-3")!;
		const provider = alpha1.provider;

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			alpha1,
			harness.session.modelRuntime,
			[{ model: alpha2 }, { model: alpha3 }, { model: alpha1 }],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).not.toContain("Refreshing");
			expect(rendered).toContain("alpha-1");
		});

		expect(selectedModelId(selector)).toBe(`${provider}/alpha-1`);

		for (const char of "alpha") {
			selector.handleInput(char);
		}

		expect(selectedModelId(selector)).toBe(`${provider}/alpha-2`);
	});
});
