import { setKeybindings } from "@huranth/gama-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ThinkingSelectorComponent } from "../src/modes/tui/parts/thinking-selector.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("thinking selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("browses levels while keeping the rendering marker-free", () => {
		const selector = new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
			undefined,
			"medium",
		);

		expect(selector.getSelectList().getSelectedItem()?.label).toBe("steady");
		const rendered = stripAnsi(selector.render(80).join("\n"));
		expect(rendered).toContain("steady");
		expect(rendered).toContain("pushing");

		selector.handleInput("\x1b[B");
		expect(selector.getSelectList().getSelectedItem()?.label).toBe("pushing");
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("steady");
	});

	it("uses the configured save binding", () => {
		setKeybindings(new KeybindingsManager({ "app.thinking.save": "ctrl+r" }));
		const saveDefault = vi.fn();
		const selector = new ThinkingSelectorComponent(
			"medium",
			["medium", "high"],
			() => {},
			() => {},
			saveDefault,
		);

		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith("medium");
	});
});
