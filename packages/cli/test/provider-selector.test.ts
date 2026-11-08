import { setKeybindings } from "@huranth/gama-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Keymap } from "../src/core/hotkeys.ts";
import { ProviderSelectorComponent } from "../src/term/parts/provider-selector.ts";
import { initTheme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 100;

function render(selector: ProviderSelectorComponent): string {
	return stripAnsi(selector.render(WIDTH).join("\n"));
}

describe("provider selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new Keymap());
	});

	it("lists each configured provider with its base URL and auth source", () => {
		const selector = new ProviderSelectorComponent({
			providers: [
				{ id: "localhost", baseUrl: "http://localhost:9000/v1", authLabel: "stored" },
				{ id: "tokenharbor", baseUrl: "https://tokenharbor.ai/v1", authLabel: "stored" },
			],
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = render(selector);
		expect(output).toContain("tokenharbor");
		expect(output).toContain("https://tokenharbor.ai/v1");
		expect(output).toContain("localhost");
		expect(output).toContain("stored");
	});

	it("selects the highlighted provider", () => {
		const onSelect = vi.fn();
		const selector = new ProviderSelectorComponent({
			providers: [{ id: "alpha" }, { id: "beta" }],
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("j");
		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith("beta");
	});

	it("asks once before deleting and confirms with d, without the key hint", () => {
		const onDelete = vi.fn();
		const selector = new ProviderSelectorComponent({
			providers: [{ id: "alpha" }],
			onSelect: () => {},
			onDelete,
			onCancel: () => {},
		});

		selector.handleInput("d");
		const prompt = render(selector);
		expect(prompt).toContain('Delete provider "alpha"?');
		expect(prompt).not.toContain("Enter to confirm");

		selector.handleInput("\n");
		expect(onDelete).not.toHaveBeenCalled();

		selector.handleInput("d");
		expect(onDelete).toHaveBeenCalledWith("alpha");
	});

	it("cancels and never walks past the ends of the list", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new ProviderSelectorComponent({
			providers: [{ id: "alpha" }, { id: "beta" }],
			onSelect,
			onCancel,
		});

		selector.handleInput("k");
		selector.handleInput("k");
		selector.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSelect).not.toHaveBeenCalled();
	});
});
