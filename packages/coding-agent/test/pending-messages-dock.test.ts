import { Spacer } from "@huranth/gama-tui";
import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";
import { UserMessageComponent } from "../src/modes/tui/parts/user-message.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";

function fakeMode(queued: { steering: string[]; followUp: string[] }) {
	const children: unknown[] = [];
	return {
		fakeThis: {
			pendingMessagesContainer: {
				children,
				clear: () => {
					children.length = 0;
				},
				addChild: (component: unknown) => {
					children.push(component);
				},
			},
			getAllQueuedMessages: () => queued,
			getMarkdownThemeWithSettings: () => ({}) as never,
			outputPad: 1,
			getMarkdownTransformers: () => [],
		},
		children,
	};
}

describe("queued prompt dock", () => {
	test("queued prompts render as real prompt bands, spaced like chat, in delivery order", () => {
		initTheme("dark");
		const { fakeThis, children } = fakeMode({
			steering: ["make the footer sticky instead"],
			followUp: ["also cap output at 20 lines"],
		});

		(InteractiveMode as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		expect(children.length).toBe(4);
		expect(children[0] instanceof Spacer).toBe(true);
		expect(children[1] instanceof UserMessageComponent).toBe(true);
		expect(children[2] instanceof Spacer).toBe(true);
		expect(children[3] instanceof UserMessageComponent).toBe(true);

		// Exact replica
		expect((children[1] as UserMessageComponent).render(60)).toEqual(
			new UserMessageComponent(
				"make the footer sticky instead",
				fakeThis.getMarkdownThemeWithSettings(),
				1,
				[],
			).render(60),
		);
	});

	test("clears the dock when the queue empties, so delivery reads as the card going up", () => {
		initTheme("dark");
		const { fakeThis, children } = fakeMode({ steering: [], followUp: [] });

		(InteractiveMode as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		expect(children.length).toBe(0);
	});
});
