import type { TuiMouseEvent } from "@huranth/gama-tui";
import { Spacer, visibleWidth } from "@huranth/gama-tui";
import { describe, expect, test, vi } from "vitest";
import { TermApp } from "../src/term/app.ts";
import { QueuedMessagesComponent } from "../src/term/parts/queued-messages.ts";
import { UserMessageComponent } from "../src/term/parts/user-message.ts";
import { initTheme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeMode(
	queued: { steering: string[]; followUp: string[] },
	pendingBashComponents: unknown[] = [],
) {
	const children: unknown[] = [];
	const fakeThis = {
		pendingMessagesContainer: {
			children,
			clear: () => {
				children.length = 0;
			},
			addChild: (component: unknown) => {
				children.push(component);
			},
		},
		pendingBashComponents,
		outputPad: 1,
		getMarkdownThemeWithSettings: () => ({}),
		getMarkdownTransformers: () => [],
		getAllQueuedMessages: () => queued,
		queuedMessagesComponent: undefined,
		ui: { requestRender: vi.fn() },
	} as Record<string, unknown>;

	Object.assign(fakeThis, {
		getQueuedMessagesComponent: (messages: string[]) =>
			(TermApp as any).prototype.getQueuedMessagesComponent.call(
				fakeThis,
				messages,
			),
	});

	return { fakeThis, children };
}

function renderLines(component: QueuedMessagesComponent, width = 60): string[] {
	return component.render(width).map(stripAnsi);
}

function clickAt(
	component: QueuedMessagesComponent,
	x: number,
	row: number,
	width = 60,
): ReturnType<QueuedMessagesComponent["handleMouse"]> {
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x,
		y: row,
		screenX: x,
		screenY: row,
		width,
		height: component.render(width).length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};

	return component.handleMouse(event);
}

function clickButton(component: QueuedMessagesComponent, row: number, width = 60): void {
	expect(clickAt(component, 3, row, width)?.handled).toBe(true);
}

describe("queued prompt dock", () => {
	test("expands into a connected queued heading and message card", () => {
		initTheme("dark");
		const { fakeThis, children } = fakeMode({
			steering: [],
			followUp: ["make the footer sticky instead", "also cap output at 20 lines"],
		});

		(TermApp as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		expect(children.length).toBe(2);
		expect(children[0] instanceof Spacer).toBe(true);

		const card = children[1] as QueuedMessagesComponent;
		expect(card).toBeInstanceOf(QueuedMessagesComponent);

		const collapsed = renderLines(card);
		const collapsedText = collapsed.join("\n");

		expect(collapsed).toHaveLength(3);
		expect(collapsedText).not.toContain("queued");
		expect(collapsedText).toContain("Show");
		expect(collapsedText).not.toContain("┌");
		expect(collapsedText).not.toContain("│");
		expect(collapsedText).not.toContain("└");
		expect(collapsed.every((line) => visibleWidth(line) === 60)).toBe(true);

		expect(clickAt(card, 20, 1)?.handled).toBeUndefined();
		expect(renderLines(card).join("\n")).not.toContain("make the footer");

		clickButton(card, 1);

		const expanded = renderLines(card);
		const expandedText = expanded.join("\n");

		expect(expandedText).not.toContain("queued");
		expect(expandedText).toContain("Hide");
		expect(expandedText).not.toContain("Show");
		expect(expandedText).toContain("• make the footer sticky instead");
		expect(expandedText).toContain("• also cap output at 20 lines");
		expect(expandedText).not.toContain("┌");
		expect(expandedText).not.toContain("│");
		expect(expandedText.trim().startsWith("Hide")).toBe(true);

		expect(expanded[3]?.trim()).toBe("");
		expect(expanded[4]).toContain("• make the footer");
		expect(expanded[5]?.trim()).toBe("");
		expect(expanded[6]).toContain("• also cap output");
		expect(expanded.every((line) => visibleWidth(line) === 60)).toBe(true);

		clickButton(card, 1);

		const recollapsed = renderLines(card).join("\n");
		expect(recollapsed).not.toContain("make the footer");
		expect(recollapsed).toContain("Show");
	});

	test("shows every queued prompt instead of a preview cap", () => {
		initTheme("dark");
		const { fakeThis, children } = fakeMode({
			steering: [],
			followUp: ["one", "two", "three", "four", "five"],
		});

		(TermApp as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		const card = children[1] as QueuedMessagesComponent;
		clickButton(card, 1);

		const text = renderLines(card).join("\n");

		expect(text).toContain("• one");
		expect(text).toContain("• three");
		expect(text).toContain("• five");
		expect(text).toContain("Hide");
		expect(text).not.toContain("more");
	});

	test("shows steering prompts as prompt cards above the input", () => {
		initTheme("dark");
		const { fakeThis, children } = fakeMode({
			steering: ["send this on the next call"],
			followUp: ["queue this one"],
		});

		(TermApp as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		expect(children).toHaveLength(4);
		expect(children[0] instanceof Spacer).toBe(true);

		const steeringCard = children[1] as UserMessageComponent;
		expect(steeringCard).toBeInstanceOf(UserMessageComponent);

		const steeringText = stripAnsi(steeringCard.render(60).join("\n"));
		expect(steeringText).toContain("send this on the next call");
		expect(steeringText).not.toContain("queue this one");

		expect(children[2] instanceof Spacer).toBe(true);

		const queueCard = children[3] as QueuedMessagesComponent;
		clickButton(queueCard, 1);
		const queueText = renderLines(queueCard).join("\n");

		expect(queueText).toContain("• queue this one");
		expect(queueText).not.toContain("send this on the next call");
	});

	test("hides held prompts while a hand view is open and restores them on return", () => {
		initTheme("dark");
		const { fakeThis, children } = fakeMode({
			steering: ["hold this for the next model call"],
			followUp: ["queue this one"],
		});

		fakeThis.handViewId = "hand-1";
		(TermApp as any).prototype.updatePendingMessagesDisplay.call(fakeThis);
		expect(children).toHaveLength(0);

		fakeThis.handViewId = undefined;
		(TermApp as any).prototype.updatePendingMessagesDisplay.call(fakeThis);
		expect(children).toHaveLength(4);
		expect(
			stripAnsi((children[1] as UserMessageComponent).render(60).join("\n")),
		).toContain("hold this for the next model call");
	});

	test("clears the dock when the queue empties", () => {
		initTheme("dark");
		const { fakeThis, children } = fakeMode({ steering: [], followUp: [] });

		(TermApp as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		expect(children.length).toBe(0);
	});

	test("keeps a streaming !cmd block attached when the dock is rebuilt", () => {
		initTheme("dark");
		const bash = { render: () => [] };
		const empty = fakeMode({ steering: [], followUp: [] }, [bash]);

		(TermApp as any).prototype.updatePendingMessagesDisplay.call(empty.fakeThis);

		expect(empty.children).toEqual([bash]);

		const queued = fakeMode({ steering: [], followUp: ["next"] }, [bash]);

		(TermApp as any).prototype.updatePendingMessagesDisplay.call(queued.fakeThis);

		expect(queued.children[0]).toBe(bash);
		expect(queued.children.length).toBe(3);
	});
});
