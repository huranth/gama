import { setKeybindings } from "@huranth/gama-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ProviderSelectorComponent } from "../src/modes/tui/parts/provider-selector.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
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
		setKeybindings(new KeybindingsManager());
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
