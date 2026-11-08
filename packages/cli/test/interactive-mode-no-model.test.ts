import { Container } from "@huranth/gama-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { TermApp } from "../src/term/app.ts";
import { UserMessageComponent } from "../src/term/parts/user-message.ts";
import { initTheme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const prototype = TermApp.prototype as any;

function fakeMode(model: object | undefined) {
	return {
		showPromptWithoutModel: prototype.showPromptWithoutModel,
		addChatChild: prototype.addChatChild,
		showError: prototype.showError,
		defaultEditor: { onSubmit: undefined as ((text: string) => Promise<void>) | undefined },
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		session: { model, isCompacting: false, isStreaming: false, prompt: vi.fn() },
		chatContainer: new Container(),
		outputPad: 1,
		ui: { requestRender: vi.fn() },
		dismissWelcomeLogo: vi.fn(),
		routeBuiltinInput: vi.fn(async () => false),
		getMarkdownThemeWithSettings: () => ({}),
		getMarkdownTransformers: () => [],
		showWarning: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		pendingUserInputs: [] as string[],
		onInputCallback: undefined as ((text: string) => void) | undefined,
	};
}

function setupSubmit(model: object | undefined) {
	const fake = fakeMode(model);
	prototype.setupEditorSubmitHandler.call(fake);
	return fake;
}

function renderChat(fake: ReturnType<typeof fakeMode>): string {
	return stripAnsi(fake.chatContainer.render(80).join("\n"));
}

describe("editor submit without a model", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows the prompt and an error below it instead of sending it", async () => {
		const fake = setupSubmit(undefined);

		await fake.defaultEditor.onSubmit!("write a test");

		const output = renderChat(fake);
		const promptIndex = output.indexOf("write a test");
		const errorIndex = output.indexOf("Error: No models available");

		expect(promptIndex).toBeGreaterThanOrEqual(0);
		expect(errorIndex).toBeGreaterThan(promptIndex);
		expect(fake.showWarning).not.toHaveBeenCalled();
		expect(fake.editor.setText).toHaveBeenCalledWith("");
		expect(fake.editor.addToHistory).toHaveBeenCalledWith("write a test");
		expect(fake.pendingUserInputs).toEqual([]);
		expect(fake.session.prompt).not.toHaveBeenCalled();
		expect(fake.chatContainer.children[0]).toBeInstanceOf(UserMessageComponent);
	});

	test("shows the prompt and error for the placeholder unknown model", async () => {
		const fake = setupSubmit({ id: "unknown", api: "unknown", provider: "unknown" });

		await fake.defaultEditor.onSubmit!("write a test");

		const output = renderChat(fake);

		expect(output).toContain("write a test");
		expect(output).toContain("Error: No models available");
		expect(fake.showWarning).not.toHaveBeenCalled();
		expect(fake.pendingUserInputs).toEqual([]);
		expect(fake.chatContainer.children[0]).toBeInstanceOf(UserMessageComponent);
	});

	test("queues the prompt once a model is selected", async () => {
		const fake = setupSubmit({ provider: "test", id: "model", api: "openai-completions" });

		await fake.defaultEditor.onSubmit!("write a test");

		expect(fake.showWarning).not.toHaveBeenCalled();
		expect(renderChat(fake)).not.toContain("No models available");
		expect(fake.pendingUserInputs).toEqual(["write a test"]);
	});
});
