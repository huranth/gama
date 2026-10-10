import type { Model } from "@huranth/gama-ai";
import { setKeybindings, type TUI } from "@huranth/gama-tui";
import chalk from "chalk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/tui/parts/model-selector.ts";
import { initTheme, theme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const browsedModel = harness.getModel("browsed-model")!;
		const provider = currentModel.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[{ model: currentModel }, { model: browsedModel }],
			() => {},
			() => {},
		);
		const previousChalkLevel = chalk.level;
		chalk.level = 3;

		try {
			const rows = () => selector.render(120);
			const rowFor = (id: string) => rows().find((line) => stripAnsi(line).includes(id));
			const isMarkedCurrent = (id: string) =>
				(rowFor(id) ?? "").includes(theme.getFgAnsi("selectionText"));

			expect(rows().some((line) => line.includes(theme.getBgAnsi("selectedBg")))).toBe(true);
			expect(stripAnsi(rows().join("\n"))).not.toMatch(/selected |current /);

			selector.handleInput("\x1b[B");
			expect(rowFor("current-model")).toContain(`${provider}/current-model`);
			expect(rowFor("browsed-model")).toContain(`${provider}/browsed-model`);
			expect(isMarkedCurrent("current-model")).toBe(true);
			expect(isMarkedCurrent("browsed-model")).toBe(false);
		} finally {
			chalk.level = previousChalkLevel;
		}
		selector.dispose();
	});

	it("filters to matching models without provider headers", () => {
		const models = [
			{ provider: "tokenharbor", id: "mimo-v2.5-pro", name: "MiMo 2.5 Pro" },
			{ provider: "tokenharbor", id: "muse-spark-1.2", name: "Muse Spark" },
			{ provider: "aetherapi", id: "gpt-oss-120b", name: "GPT OSS" },
			{ provider: "aetherapi", id: "o3", name: "o3" },
		].map((model) => ({ ...model, reasoning: true })) as unknown as Model<any>[];
		const runtime = {
			getAvailableSnapshot: () => models,
			getModel: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
		} as unknown as ModelRuntime;

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			models[0],
			runtime,
			[],
			() => {},
			() => {},
			"pro",
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		);

		const lines = selector.render(120).map((line) => stripAnsi(line));
		const text = lines.join("\n");
		expect(text).toContain("tokenharbor/mimo-v2.5-pro");
		expect(text).not.toContain("muse-spark");
		expect(text).not.toContain("gpt-oss");
		expect(text).not.toContain("aetherapi/o3");
		expect(lines.some((line) => line.trim() === "tokenharbor")).toBe(false);
		expect(lines.some((line) => line.trim() === "aetherapi")).toBe(false);

		selector.dispose();
	});

	it("renders one heading per provider when the current model is in a later provider", () => {
		const models = [
			{ provider: "alpha", id: "a1", name: "Alpha One" },
			{ provider: "zeta", id: "current", name: "Zeta Current" },
			{ provider: "alpha", id: "a2", name: "Alpha Two" },
			{ provider: "zeta", id: "z2", name: "Zeta Two" },
		].map((model) => ({ ...model, reasoning: true })) as unknown as Model<any>[];
		const currentModel = models[1]!;
		const runtime = {
			getAvailableSnapshot: () => models,
			getModel: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
		} as unknown as ModelRuntime;

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			runtime,
			[],
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		);

		const lines = selector.render(120).map((line) => stripAnsi(line));
		const providerHeaders = lines
			.map((line) => line.trim())
			.filter((line) => line === "alpha" || line === "zeta");
		expect(providerHeaders).toEqual(["zeta", "alpha"]);

		const headerIndex = (provider: string) => lines.findIndex((line) => line.trim() === provider);
		const rowIndex = (provider: string, id: string) =>
			lines.findIndex((line) => line.trim() === `${provider}/${id}`);

		const zetaHeader = headerIndex("zeta");
		const alphaHeader = headerIndex("alpha");
		expect(rowIndex("zeta", "current")).toBeGreaterThan(zetaHeader);
		expect(rowIndex("zeta", "z2")).toBeGreaterThan(zetaHeader);
		expect(rowIndex("zeta", "z2")).toBeLessThan(alphaHeader);
		expect(rowIndex("alpha", "a1")).toBeGreaterThan(alphaHeader);
		expect(rowIndex("alpha", "a2")).toBeGreaterThan(rowIndex("alpha", "a1"));

		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
	});

	it("keeps cached models listed after a failed refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).not.toContain("Refreshing");
			expect(rendered).toContain("faux/");
		});
		selector.dispose();
	});
});
