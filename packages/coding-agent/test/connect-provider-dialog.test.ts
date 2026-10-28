import { setKeybindings, type TuiMouseEvent } from "@huranth/gama-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ConnectProviderDialogComponent } from "../src/modes/tui/parts/connect-provider-dialog.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 100;

function mouseEvent(partial: Partial<TuiMouseEvent> & Pick<TuiMouseEvent, "y">): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 0,
		screenX: 0,
		screenY: partial.y,
		width: WIDTH,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
		...partial,
	};
}

function render(dialog: ConnectProviderDialogComponent): string {
	return stripAnsi(dialog.render(WIDTH).join("\n"));
}

function rowOf(dialog: ConnectProviderDialogComponent, fragment: string): number {
	return render(dialog)
		.split("\n")
		.findIndex((line) => line.includes(fragment));
}

describe("connect provider dialog", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the two fields, a Continue button and key hints", () => {
		const dialog = new ConnectProviderDialogComponent({
			onContinue: () => {},
			onCancel: () => {},
		});
		const output = render(dialog);
		expect(output).toContain("Connect a provider");
		expect(output).toContain("Base URL");
		expect(output).toContain("API key");
		expect(output).toContain("Continue");
	});

	it("masks the API key but not the base URL", () => {
		const dialog = new ConnectProviderDialogComponent({
			onContinue: () => {},
			onCancel: () => {},
			initialBaseUrl: "https://tokenharbor.ai/v1",
			initialApiKey: "sk-prefilled",
		});
		dialog.handleInput("\r");
		dialog.handleInput("-typed");
		const output = render(dialog);
		expect(output).toContain("https://tokenharbor.ai/v1");
		expect(output).not.toContain("sk-prefilled");
		expect(output).not.toContain("typed");
		expect(output).toContain("•".repeat("sk-prefilled-typed".length));
	});

	it("can be reused to edit an existing provider", () => {
		const dialog = new ConnectProviderDialogComponent({
			onContinue: () => {},
			onCancel: () => {},
			title: "Edit provider tokenharbor",
			submitLabel: "Save",
			initialBaseUrl: "https://tokenharbor.ai/v1",
			apiKeyPlaceholder: "unchanged",
			apiKeyHint: "A key is already stored. Leave blank to keep it.",
		});
		const output = render(dialog);
		expect(output).toContain("Edit provider tokenharbor");
		expect(output).toContain("https://tokenharbor.ai/v1");
		expect(output).toContain("Save");
		expect(output).toContain("A key is already stored. Leave blank to keep it.");
		expect(output).not.toContain("Continue");
	});

	it("submits an empty key when left blank so an edit can keep the stored one", () => {
		const onContinue = vi.fn();
		const dialog = new ConnectProviderDialogComponent({
			onContinue,
			onCancel: () => {},
			initialBaseUrl: "https://tokenharbor.ai/v1",
		});
		dialog.handleInput("\r");
		dialog.handleInput("\r");

		expect(onContinue).toHaveBeenCalledWith({ baseUrl: "https://tokenharbor.ai/v1", apiKey: "" });
	});

	it("continues with Enter after filling both fields", () => {
		const onContinue = vi.fn();
		const dialog = new ConnectProviderDialogComponent({ onContinue, onCancel: () => {} });
		dialog.handleInput("https://tokenharbor.ai/v1");
		dialog.handleInput("\t");
		dialog.handleInput("sk-secret");
		dialog.handleInput("\r");
		expect(onContinue).toHaveBeenCalledWith({
			baseUrl: "https://tokenharbor.ai/v1",
			apiKey: "sk-secret",
		});
	});

	it("continues on Enter with an empty API key", () => {
		const onContinue = vi.fn();
		const dialog = new ConnectProviderDialogComponent({ onContinue, onCancel: () => {} });
		dialog.handleInput("http://localhost:11434/v1");
		dialog.handleInput("\r");
		dialog.handleInput("\r");
		expect(onContinue).toHaveBeenCalledWith({ baseUrl: "http://localhost:11434/v1", apiKey: "" });
	});

	it("continues on a mouse click of the Continue button", () => {
		const onContinue = vi.fn();
		const dialog = new ConnectProviderDialogComponent({ onContinue, onCancel: () => {} });
		dialog.render(WIDTH);
		dialog.handleInput("https://tokenharbor.ai/v1");
		dialog.handleInput("\t");
		dialog.handleInput("sk-secret");
		dialog.handleMouse(mouseEvent({ y: rowOf(dialog, "Continue") }));
		expect(onContinue).toHaveBeenCalledWith({
			baseUrl: "https://tokenharbor.ai/v1",
			apiKey: "sk-secret",
		});
	});

	it("focuses the API key field when it is clicked", () => {
		const onContinue = vi.fn();
		const dialog = new ConnectProviderDialogComponent({ onContinue, onCancel: () => {} });
		dialog.render(WIDTH);
		dialog.handleInput("https://tokenharbor.ai/v1");
		dialog.handleMouse(mouseEvent({ y: rowOf(dialog, "API key") + 1, type: "press" }));
		dialog.handleInput("sk-typed-by-mouse");
		dialog.handleInput("\r");
		expect(onContinue).toHaveBeenCalledWith({
			baseUrl: "https://tokenharbor.ai/v1",
			apiKey: "sk-typed-by-mouse",
		});
	});

	it("draws a white bold text cursor in only the active field", () => {
		const dialog = new ConnectProviderDialogComponent({
			onContinue: () => {},
			onCancel: () => {},
		});
		dialog.focused = true;
		const countCursors = () =>
			dialog.render(WIDTH).filter((line) => line.includes("\x1b[1;97;7m")).length;
		expect(countCursors()).toBe(0);
		dialog.handleInput("\t");
		expect(countCursors()).toBe(1);
		dialog.handleInput("\t");
		expect(countCursors()).toBe(1);
	});

	it("deletes with a raw 0x08 backspace", () => {
		const previous = process.env.WT_SESSION;
		process.env.WT_SESSION = "test-session";
		try {
			const onContinue = vi.fn();
			const dialog = new ConnectProviderDialogComponent({ onContinue, onCancel: () => {} });
			dialog.handleInput("https://x.dev");
			dialog.handleInput("\x08");
			dialog.handleInput("\x08");
			dialog.handleInput("\t");
			dialog.handleInput("sk-1");
			dialog.handleInput("\r");
			expect(onContinue).toHaveBeenCalledWith({ baseUrl: "https://x.d", apiKey: "sk-1" });
		} finally {
			if (previous === undefined) delete process.env.WT_SESSION;
			else process.env.WT_SESSION = previous;
		}
	});

	it("cancels on Escape", () => {
		const onCancel = vi.fn();
		const dialog = new ConnectProviderDialogComponent({ onContinue: () => {}, onCancel });
		dialog.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalled();
	});
});
