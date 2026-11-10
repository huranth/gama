import {
	Container,
	Editor,
	getKeybindings,
	MainScreen,
	setKeybindings,
	stripTerminalSequences,
} from "@huranth/gama-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../ui/test/virtual-terminal.ts";
import { redactJsonValue, redactUrl } from "../src/core/bug-report.ts";
import { Keymap } from "../src/core/hotkeys.ts";
import type { RunSession } from "../src/core/session/session.ts";
import { reportBug } from "../src/term/bug.ts";
import { ExtensionEditorComponent } from "../src/term/parts/extension-editor.ts";
import { ExtensionSelectorComponent } from "../src/term/parts/extension-selector.ts";
import { getEditorTheme, initTheme } from "../src/term/theme/theme.ts";

beforeAll(() => initTheme("dark"));

describe("bug report prompt", () => {
	it("preserves line breaks in pasted descriptions", async () => {
		const previousKeybindings = getKeybindings();
		const keybindings = new Keymap();
		setKeybindings(keybindings);
		try {
			const ui = new MainScreen(new VirtualTerminal());
			const editorContainer = new Container();
			const editor = new Editor(ui, getEditorTheme());
			const session = {
				model: undefined,
				settingsManager: { getExternalEditorCommand: () => "nano" },
			} as unknown as RunSession;
			const showStatus = vi.fn();

			const report = reportBug({
				session,
				ui,
				editorContainer,
				editor,
				keybindings,
				showStatus,
				showError: vi.fn(),
			});

			const descriptionEditor = editorContainer.children[0];
			expect(descriptionEditor).toBeInstanceOf(ExtensionEditorComponent);
			if (!(descriptionEditor instanceof ExtensionEditorComponent))
				throw new Error("Missing description editor");
			descriptionEditor.handleInput(
				"\x1b[200~Request failed\r\n  ↳ gama exiting...\r\nstack trace\x1b[201~",
			);
			descriptionEditor.handleInput("\r");
			expect(editorContainer.children[0]).toBe(editor);

			await vi.waitFor(() =>
				expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent),
			);
			const transcriptSelector = editorContainer.children[0];
			if (!(transcriptSelector instanceof ExtensionSelectorComponent))
				throw new Error("Missing transcript selector");
			expect(transcriptSelector.render(120).join("\n")).toContain(
				"Include the session transcript?",
			);
			transcriptSelector.handleInput("j");
			transcriptSelector.handleInput("\r");
			expect(editorContainer.children[0]).toBe(editor);

			await vi.waitFor(() =>
				expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent),
			);
			const summarySelector = editorContainer.children[0];
			if (!(summarySelector instanceof ExtensionSelectorComponent))
				throw new Error("Missing summary selector");
			expect(summarySelector.render(120).join("\n")).toContain("Attach a summary written by");
			summarySelector.handleInput("j");
			summarySelector.handleInput("\r");
			expect(editorContainer.children[0]).toBe(editor);

			await vi.waitFor(() =>
				expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent),
			);
			const deliverySelector = editorContainer.children[0];
			if (!(deliverySelector instanceof ExtensionSelectorComponent))
				throw new Error("Missing delivery selector");
			const deliveryLines = deliverySelector.render(120).map(stripTerminalSequences);
			expect(deliveryLines.some((line) => line.includes("Description: Request failed"))).toBe(
				true,
			);
			expect(deliveryLines.some((line) => line.includes("↳ gama exiting..."))).toBe(true);
			expect(deliveryLines.some((line) => line.includes("stack trace"))).toBe(true);

			deliverySelector.handleInput("j");
			deliverySelector.handleInput("j");
			deliverySelector.handleInput("\r");
			await report;
			expect(showStatus).toHaveBeenCalledWith("Report cancelled");
		} finally {
			setKeybindings(previousKeybindings);
		}
	});
});

describe("bug report redaction", () => {
	it("removes URL credentials and secret query parameters", () => {
		expect(redactUrl("https://user:pass@proxy.example.com:8080/")).toBe(
			"https://proxy.example.com:8080/",
		);
		expect(redactUrl("git:https://pat@github.com/org/repo")).toBe(
			"git:https://github.com/org/repo",
		);
		expect(redactUrl("https://api.example/v1?api-key=abc&model=x")).toBe(
			"https://api.example/v1?api-key=%3Credacted%3E&model=x",
		);
	});

	it("redacts nested secret values without hiding token counts", () => {
		expect(
			redactJsonValue({
				apiKey: "sk-123",
				headers: { Authorization: "Bearer x", "X-Trace": "1" },
				compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
				baseUrl: "https://me:secret@example.com/",
			}),
		).toEqual({
			apiKey: "<redacted>",
			headers: { Authorization: "<redacted>", "X-Trace": "1" },
			compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
			baseUrl: "https://example.com/",
		});
	});
});
