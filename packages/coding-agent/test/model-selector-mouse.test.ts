import { setKeybindings, type TUI, type TuiMouseEvent } from "@huranth/gama-tui";
import chalk from "chalk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/tui/parts/model-selector.ts";
import { initTheme, theme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const WIDTH = 120;
describe("model selector mouse", () => {
	let harness: Harness | undefined;
	let previousChalkLevel: (typeof chalk)["level"] = 0;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		chalk.level = previousChalkLevel;
		previousChalkLevel = 0;
		harness?.cleanup();
		harness = undefined;
	});

	it("selects the clicked model row", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-model", name: "Alpha Model", reasoning: true },
				{ id: "beta-model", name: "Beta Model", reasoning: true },
			],
		});
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
			undefined,
			undefined,
			undefined,
			"faux",
		);

		const lines = stripAnsi(selector.render(WIDTH).join("\n")).split("\n");
		const row = lines.findIndex((line) => line.includes("beta-model"));
		expect(row).toBeGreaterThanOrEqual(0);

		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 0,
			y: row,
			screenX: 0,
			screenY: row,
			width: WIDTH,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		};
		selector.handleMouse(event);
		expect(onSelect).toHaveBeenCalledWith(harness.getModel("beta-model"));
		selector.dispose();
	});

	it("opens the provider dialog from the connect row", async () => {
		harness = await createHarness({
			models: [{ id: "alpha-model", name: "Alpha Model", reasoning: true }],
		});
		const onConnectProvider = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			onConnectProvider,
		);

		const lines = stripAnsi(selector.render(WIDTH).join("\n")).split("\n");
		const row = lines.findIndex((line) => line.includes("Connect"));
		expect(row).toBeGreaterThanOrEqual(0);

		selector.handleMouse({
			type: "click",
			button: "left",
			x: 0,
			y: row,
			screenX: 0,
			screenY: row,
			width: WIDTH,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(onConnectProvider).toHaveBeenCalledTimes(1);
		selector.dispose();
	});

	it("scrolls the viewport with the wheel while arrows move the selection", async () => {
		harness = await createHarness({
			models: Array.from({ length: 13 }, (_, i) => ({
				id: `model-${i}`,
				name: `Model ${i}`,
				reasoning: true,
			})),
		});
		const current = harness.getModel("model-0")!;
		const provider = current.provider;
		previousChalkLevel = chalk.level;
		chalk.level = 3;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			"faux",
		);

		const lines = () => stripAnsi(selector.render(WIDTH).join("\n")).split("\n");
		const selectedRow = () => {
			const selectedBg = theme.getBgAnsi("selectedBg");
			const row = selector.render(WIDTH).find((line) => line.includes(selectedBg));
			return row === undefined ? undefined : stripAnsi(row).trim();
		};

		expect(selectedRow()).toBe(`${provider}/model-0`);

		const initialLines = lines();
		const row = initialLines.findIndex((line) => line.includes("model-2"));
		selector.handleMouse({
			type: "wheel",
			button: "none",
			x: 0,
			y: row,
			screenX: 0,
			screenY: row,
			width: WIDTH,
			height: initialLines.length,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 1,
		});

		expect(lines().some((line) => line.includes("model-0"))).toBe(false);
		expect(lines().some((line) => line.includes("model-10"))).toBe(true);
		expect(selectedRow()).toBe(`${provider}/model-1`);

		selector.handleInput("\x1b[A");
		expect(selectedRow()).toBe(`${provider}/model-0`);
		expect(lines().some((line) => line.includes("model-0"))).toBe(true);

		selector.dispose();
	});
});
