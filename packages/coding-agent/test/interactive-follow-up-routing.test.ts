import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";

function fakeMode(text: string) {
	return {
		editor: {
			getText: () => text,
			setText: vi.fn(),
			addToHistory: vi.fn(),
			onSubmit: undefined,
		},
		session: { isCompacting: false, isStreaming: true, isBashRunning: false, prompt: vi.fn() },
		routeBuiltinInput: Reflect.get(InteractiveMode.prototype, "routeBuiltinInput"),
		handleModelCommand: vi.fn(async () => {}),
		handleBashCommand: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		reportPromptFailure: vi.fn(),
	};
}

async function followUp(fake: ReturnType<typeof fakeMode>): Promise<void> {
	const handleFollowUp = Reflect.get(InteractiveMode.prototype, "handleFollowUp") as (
		this: typeof fake,
	) => Promise<void>;
	await handleFollowUp.call(fake);
}

describe("follow-up routing while streaming", () => {
	test("runs !cmd as bash instead of queueing it for the model", async () => {
		const fake = fakeMode("!ls -la");
		await followUp(fake);
		expect(fake.handleBashCommand).toHaveBeenCalledWith("ls -la", false);
		expect(fake.session.prompt).not.toHaveBeenCalled();
	});

	test("opens builtin /model instead of queueing it for the model", async () => {
		const fake = fakeMode("/model foo");
		await followUp(fake);
		expect(fake.handleModelCommand).toHaveBeenCalledWith("foo");
		expect(fake.session.prompt).not.toHaveBeenCalled();
	});

	test("still queues plain text as a follow-up", async () => {
		const fake = fakeMode("also add tests");
		await followUp(fake);
		expect(fake.session.prompt).toHaveBeenCalledWith("also add tests", {
			streamingBehavior: "followUp",
		});
	});
});
