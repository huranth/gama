import { Container, type TUI } from "@huranth/gama-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/tui/interactive-mode.ts";
import { ActivityLineComponent } from "../../../src/modes/tui/parts/activity.ts";
import { initTheme } from "../../../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

type UpdateThinkingBlockVisibility = (this: { chatContainer: Container; ui: TUI }) => void;

type ToggleThinkingBlockVisibility = (this: {
	hideThinkingBlock: boolean;
	settingsManager: { setHideThinkingBlock(hidden: boolean): void };
	updateThinkingBlockVisibility(): void;
	showStatus(message: string): void;
}) => void;

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("thinking visibility while a bash tool is running (#8611)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("preserves partial bash output", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const chatContainer = new Container();
		const component = new ActivityLineComponent({
			record: {
				toolCallId: "tool-8611",
				name: "bash",
				args: { command: "echo partial; sleep 10" },
				status: "running",
				result: { content: [{ type: "text", text: "PARTIAL_OUTPUT_8611" }] },
				timestamp: Date.now(),
			},
			cwd: () => process.cwd(),
		});
		component.setExpanded(true);
		chatContainer.addChild(component);

		const updateThinkingBlockVisibility = Reflect.get(
			InteractiveMode.prototype,
			"updateThinkingBlockVisibility",
		) as UpdateThinkingBlockVisibility;
		const toggleThinkingBlockVisibility = Reflect.get(
			InteractiveMode.prototype,
			"toggleThinkingBlockVisibility",
		) as ToggleThinkingBlockVisibility;
		const fakeThis = {
			hideThinkingBlock: false,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			chatContainer,
			ui,
			updateThinkingBlockVisibility() {
				updateThinkingBlockVisibility.call(this);
			},
			showStatus: vi.fn(),
		};

		expect(renderChat(chatContainer)).toContain("PARTIAL_OUTPUT_8611");
		toggleThinkingBlockVisibility.call(fakeThis);

		expect(fakeThis.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(chatContainer.children).toContain(component);
		expect(renderChat(chatContainer)).toContain("PARTIAL_OUTPUT_8611");
	});
});
