import {
	colorToRgb,
	type Component,
	type TuiMouseEvent,
	visibleWidth,
} from "@huranth/gama-tui";
import type { AssistantMessage } from "@huranth/gama-ai";
import { beforeAll, describe, expect, test } from "vitest";
import type { HandSnapshot, HandTranscriptItem } from "../src/core/hands.ts";
import { HandBackComponent } from "../src/term/parts/hand-back.ts";
import {
	handSpotlightBg,
	handSpotlightColor,
	handStatusColor,
} from "../src/term/parts/hand-colors.ts";
import { HandCardComponent } from "../src/term/parts/hand-card.ts";
import { HandGridComponent } from "../src/term/parts/hand-grid.ts";
import { fillHandLine, handBackgroundAnsi } from "../src/term/parts/hand-fill.ts";
import { HandViewComponent } from "../src/term/parts/hand-view.ts";
import type { TermApp } from "../src/term/app.ts";
import { isSilentTool } from "../src/term/chat.ts";
import { handleHandsStarted } from "../src/term/hands.ts";
import { initTheme, theme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 80;

function clickRow(component: Component, marker: string): void {
	const lines = component.render(WIDTH);
	const row = lines.findIndex((line) => stripAnsi(line).includes(marker));
	expect(row).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: WIDTH,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse?.(event)?.handled).toBe(true);
}

function assistant(text: string): HandTranscriptItem {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "end",
		timestamp: 0,
	} as unknown as AssistantMessage;
	return { role: "assistant", id: `a:${text}`, message };
}

function thinkingAssistant(text: string, streaming = false): HandTranscriptItem {
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking: text }],
		stopReason: "stop",
		timestamp: streaming ? Date.now() : 1,
	} as unknown as AssistantMessage;
	return streaming
		? { role: "assistant", id: `a:${text}`, message, streaming: true }
		: { role: "assistant", id: `a:${text}`, message };
}

function settle(item: HandTranscriptItem): HandTranscriptItem {
	return item.role === "assistant"
		? { role: "assistant", id: item.id, message: item.message }
		: item;
}

const runningHand: HandSnapshot = {
	id: "hand-1",
	index: 0,
	title: "Hand 1",
	kind: "builder",
	task: "check the login flow",
	status: "running",
	transcript: [assistant("I am checking it now")],
	startedAt: Date.now(),
};

describe("hand views", () => {
	beforeAll(() => initTheme("dark"));

	test("renders a compact clickable rectangle card", () => {
		let opened = false;
		const card = new HandCardComponent(runningHand, () => {
			opened = true;
		});

		const lines = card.render(WIDTH);
		const text = stripAnsi(lines.join("\n"));
		expect(lines).toHaveLength(5);
		expect(lines.every((line) => line.includes(theme.getBgAnsi("handBg")))).toBe(true);
		expect(lines[0]).not.toContain("\x1b[53m");
		expect(lines[3]).toContain(theme.getBgAnsi("handChipBg"));
		expect(text).toContain("Hand 1");
		expect(text).toContain("Builder");
		expect(text).not.toContain("▕");
		expect(text).not.toContain("Running");
		expect(text).not.toContain("BUILDER");
		expect(text).not.toContain("◆");
		expect(text).not.toContain("◌");
		expect(text).not.toContain("show");
		expect(text).not.toContain("check the login flow");
		expect(text).not.toContain("I am checking it now");
		expect(visibleWidth(lines[0] ?? "")).toBe(80);
		expect(lines[0]?.startsWith(" ")).toBe(true);

		card.setSnapshot({
			...runningHand,
			kind: "scout",
			status: "done",
			transcript: [assistant("all checked")],
		});
		const updatedLines = card.render(WIDTH);
		const updated = stripAnsi(updatedLines.join("\n"));
		expect(updated).toContain("Scout");
		expect(stripAnsi(updatedLines[0] ?? "").trimEnd()).toBe("");
		expect(updated).not.toContain("▕");
		expect(updated).not.toContain("SCOUT");
		expect(updated).not.toContain("Done");
		expect(updated).not.toContain("all checked");

		clickRow(card, "Hand 1");
		expect(opened).toBe(true);
	});

	test("keeps the classic card background across every status", () => {
		for (const status of ["running", "done", "failed", "cancelled"] as const) {
			const card = new HandCardComponent({ ...runningHand, status }, () => {});
			const lines = card.render(WIDTH);
			expect(lines.every((line) => line.includes(theme.getBgAnsi("handBg")))).toBe(true);
		}
	});

	test("moves a green spotlight with the pointer on running cards", () => {
		const card = new HandCardComponent(runningHand, () => {});
		const base = theme.colors.handBg;
		const accent = handSpotlightColor("running");
		if (!accent) throw new Error("expected a running spotlight");

		card.setHover(14, 2);
		const center = handSpotlightBg(base, accent, { x: 13, y: 2 }, 13, 2);
		expect(card.render(WIDTH)[2]).toContain(handBackgroundAnsi(center));

		card.setHover(24, 3);
		expect(card.render(WIDTH)[3]).toContain(handBackgroundAnsi(center));
		expect(card.render(WIDTH)[2]).not.toContain(handBackgroundAnsi(center));
	});

	test("uses a red spotlight only for failed cards", () => {
		const base = theme.colors.handBg;
		const failedAccent = handSpotlightColor("failed");
		if (!failedAccent) throw new Error("expected a failed spotlight");

		const failed = new HandCardComponent({ ...runningHand, status: "failed" }, () => {});
		failed.setHover(14, 2);
		const center = handSpotlightBg(base, failedAccent, { x: 13, y: 2 }, 13, 2);
		expect(failed.render(WIDTH)[2]).toContain(handBackgroundAnsi(center));

		expect(handSpotlightColor("done")).toBeUndefined();
		expect(handSpotlightColor("cancelled")).toBeUndefined();
		const done = new HandCardComponent({ ...runningHand, status: "done" }, () => {});
		done.setHover(14, 2);
		expect(done.render(WIDTH)[2]).not.toContain(handBackgroundAnsi(center));
	});

	test("forwards pointer movement and clears the spotlight on leave", () => {
		const grid = new HandGridComponent();
		grid.addCard(new HandCardComponent(runningHand, () => {}));
		const base = theme.colors.handBg;
		const accent = handSpotlightColor("running");
		if (!accent) throw new Error("expected a running spotlight");

		const move: TuiMouseEvent = {
			type: "move",
			button: "none",
			x: 14,
			y: 2,
			screenX: 14,
			screenY: 2,
			width: 96,
			height: 5,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 0,
		};
		expect(grid.handleMouse?.(move)?.handled).toBe(true);
		const center = handSpotlightBg(base, accent, { x: 13, y: 2 }, 13, 2);
		expect(grid.render(96)[2]).toContain(handBackgroundAnsi(center));

		grid.handleMouse?.({ ...move, type: "leave" });
		expect(grid.render(96)[2]).not.toContain(handBackgroundAnsi(center));
	});

	test("uses vivid green running and red stopped status colors", () => {
		const running = handStatusColor("running");
		const stopped = handStatusColor("cancelled");
		if (typeof running === "string" || typeof stopped === "string") {
			throw new Error("expected derived status colors");
		}

		const run = colorToRgb(running);
		const stop = colorToRgb(stopped);
		expect(run.g - run.r).toBeGreaterThan(30);
		expect(run.g - run.b).toBeGreaterThan(50);
		expect(stop.r - stop.g).toBeGreaterThan(50);
		expect(stop.r - stop.b).toBeGreaterThan(50);
	});

	test("lays hand cards out in rows and wraps", () => {
		const grid = new HandGridComponent();
		const opened: number[] = [];
		for (let index = 0; index < 4; index++) {
			grid.addCard(
				new HandCardComponent(
					{ ...runningHand, id: `hand-${index}`, index, title: `Hand ${index + 1}` },
					() => opened.push(index),
				),
			);
		}

		const lines = grid.render(96);
		const row = (start: number) => stripAnsi(lines.slice(start, start + 5).join("\n"));
		expect(row(0)).toContain("Hand 1");
		expect(row(0)).toContain("Hand 2");
		expect(row(0)).toContain("Hand 3");
		expect(row(0)).not.toContain("Hand 4");
		expect(stripAnsi(lines[5] ?? "")).toBe("");
		expect(row(6)).toContain("Hand 4");

		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 32,
			y: 2,
			screenX: 32,
			screenY: 2,
			width: 96,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		grid.handleMouse?.(event);
		expect(opened).toEqual([1]);
	});

	test("shows a failed hand's Reason and Next in the hand view", () => {
		const view = new HandViewComponent({
			...runningHand,
			status: "failed",
			error: "model stopped",
			finishedAt: Date.now(),
		});

		const text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("Reason: model stopped");
		expect(text).toContain('Next: Use action "talk"');
	});

	test("puts every hand batch below the start row that launched it", () => {
		const children: Component[] = [];
		const mode = {
			handGrid: undefined,
			handSnapshots: new Map(),
			handCards: new Map(),
			addChatChild: (component: Component) => {
				children.push(component);
				return null;
			},
			openHand: () => {},
			ui: { invalidate: () => {}, requestRender: () => {} },
		} as unknown as TermApp;
		const event = (index: number): Parameters<typeof handleHandsStarted>[1] => ({
			type: "hands_started",
			hands: [{ ...runningHand, id: `batch-${index}`, index, title: `Hand ${index + 1}` }],
		});

		handleHandsStarted(mode, event(0));
		const secondStart = { render: () => ["2 hands started"], invalidate: () => {} };
		children.push(secondStart);
		handleHandsStarted(mode, event(1));

		expect(children).toHaveLength(3);
		expect(children[0]).toBeInstanceOf(HandGridComponent);
		expect(children[1]).toBe(secondStart);
		expect(children[2]).toBeInstanceOf(HandGridComponent);
		expect(stripAnsi(children[0]!.render(WIDTH).join("\n"))).toContain("Hand 1");
		expect(stripAnsi(children[0]!.render(WIDTH).join("\n"))).not.toContain("Hand 2");
		expect(stripAnsi(children[2]!.render(WIDTH).join("\n"))).toContain("Hand 2");
	});

	test("renders a read-only transcript without a title or in-view back bar", () => {
		const view = new HandViewComponent({
			...runningHand,
			status: "done",
			result: "I am checking it now",
			finishedAt: Date.now(),
		});

		const text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).not.toContain("Hand 1");
		expect(text).not.toContain("builder hand");
		expect(text).not.toContain("done");
		expect(text).toContain("check the login flow");
		expect(text).toContain("I am checking it now");
		expect(text).not.toContain("back to main chat");
	});

	test("renders the hand's title, agent content, and explanation as written", () => {
		const reply =
			'## Core map\n\nAgent content:\n```json\n' +
				'{"files":[{"path":"src/core/index.ts","purpose":"barrel","lines":9}]}\n```\n\n' +
				'Explanation:\nThe core is a thin barrel over the registry.';
		const view = new HandViewComponent({
			...runningHand,
			kind: "scout",
			status: "done",
			result: reply,
			transcript: [assistant(reply)],
		});

		const text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("Core map");
		expect(text).toContain("Agent content:");
		expect(text).toContain("src/core/index.ts");
		expect(text).toContain("Explanation:");
		expect(text).toContain("thin barrel over the registry");
	});

	test("streams thinking, then settles to Thought, and keeps collapse state", () => {
		const item = thinkingAssistant("deep thought", true);
		const view = new HandViewComponent({
			...runningHand,
			status: "running",
			transcript: [item, { role: "user", id: "u:go", text: "go", timestamp: 2 }],
		});

		let text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("Thinking");
		expect(text).toContain("deep thought");

		clickRow(view, "Thinking");
		text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).not.toContain("deep thought");

		view.setSnapshot({
			...runningHand,
			status: "running",
			transcript: [settle(item), { role: "user", id: "u:go", text: "go", timestamp: 2 }],
		});
		text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).not.toContain("deep thought");

		clickRow(view, "Thought");
		text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("deep thought");

		view.setSnapshot({
			...runningHand,
			status: "done",
			transcript: [settle(item)],
		});
		text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("Thought");
	});

	test("shows how long a finished thought took", () => {
		const item = thinkingAssistant("settled thought");
		if (item.role !== "assistant") throw new Error("expected assistant");

		const view = new HandViewComponent({
			...runningHand,
			status: "done",
			transcript: [{ ...item, thinking: [{ startedAt: 1_000, endedAt: 3_000 }] }],
		});

		const text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("Thought 2s");
	});

	test("toggles every thinking block together", () => {
		const first = thinkingAssistant("first thought");
		const second = thinkingAssistant("second thought");
		const view = new HandViewComponent({
			...runningHand,
			status: "done",
			transcript: [first, second],
		});

		let text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("first thought");
		expect(text).toContain("second thought");

		clickRow(view, "Thought");
		text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).not.toContain("first thought");
		expect(text).not.toContain("second thought");
	});

	test("keeps collapsed thinking collapsed when a new content block arrives", () => {
		const item = thinkingAssistant("deep thought", true);
		const view = new HandViewComponent({
			...runningHand,
			status: "running",
			transcript: [item, { role: "user", id: "u:go", text: "go", timestamp: 2 }],
		});

		clickRow(view, "Thinking");
		if (item.role === "assistant") {
			item.message.content.push({ type: "text", text: "final answer" });
		}
		view.setSnapshot({
			...runningHand,
			status: "running",
			transcript: [item, { role: "user", id: "u:go", text: "go", timestamp: 2 }],
		});

		const text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("final answer");
		expect(text).not.toContain("deep thought");
	});

	test("renders tool calls as activity cards, not raw arguments", () => {
		const view = new HandViewComponent({
			...runningHand,
			status: "done",
			transcript: [
				assistant("checking the index"),
				{
					role: "tool",
					id: "t:1",
					timestamp: 1,
					toolCallId: "tool-1",
					name: "read",
					args: { path: "notes/00-index.md" },
					status: "success",
					result: { content: [{ type: "text", text: "line one\nline two" }] },
				},
			],
		});

		const text = stripAnsi(view.render(WIDTH).join("\n"));
		expect(text).toContain("notes/00-index.md");
		expect(text).toContain("2 lines");
		expect(text).not.toContain('{"path"');
		expect(text).not.toContain("↳");
	});

	test("fills the card background through padding", () => {
		const bg = theme.getBgAnsi("customMessageBg");
		const filled = fillHandLine(theme.fg("customMessageText", "Hand 1"), 30, "customMessageBg");
		expect(filled).toContain(`${bg}${" ".repeat(24)}\x1b[49m`);
	});

	test("renders a solid Back rectangle", () => {
		let wentBack = false;
		const back = new HandBackComponent(() => {
			wentBack = true;
		});

		const lines = back.render(WIDTH);
		const text = stripAnsi(lines.join("\n"));
		expect(lines).toHaveLength(3);
		expect(text).toContain("Back");
		expect(text).not.toContain("write back");
		expect(text).not.toContain("back to main chat");
		expect(lines.every((line) => line.includes(theme.getBgAnsi("selectedBg")))).toBe(true);

		clickRow(back, "Back");
		expect(wentBack).toBe(true);
	});

	test("shows hand actions in the main transcript", () => {
		expect(isSilentTool("hands")).toBe(false);
	});
});
