import type { AssistantMessage } from "@huranth/gama-ai";
import type { TuiMouseEvent } from "@huranth/gama-tui";
import { visibleWidth } from "@huranth/gama-tui";
import { describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/tui/parts/assistant-message.ts";
import { CenteredColumn } from "../src/modes/tui/parts/centered-column.ts";
import { UserMessageComponent } from "../src/modes/tui/parts/user-message.ts";
import { initTheme, theme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "hello" }]),
		);
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1]).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);
	});

	test("does not add OSC 133 zone markers when assistant message " + "contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], {
				stopReason: "length",
			}),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thought");
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).toContain("Response was truncated before completion");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thought/g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("toggles every thinking run through the shared visibility callback", () => {
		initTheme("dark");
		let hidden = false;
		let component: AssistantMessageComponent;
		const onToggle = vi.fn(() => {
			hidden = !hidden;
			component.setHideThinkingBlock(hidden);
		});
		component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
			false,
			undefined,
			"Thinking",
			1,
			[],
			undefined,
			onToggle,
		);
		const width = 80;
		const lines = component.render(width);
		const firstThinkingRow = lines.findIndex((line) =>
			stripAnsi(line).includes("first reasoning"),
		);
		expect(firstThinkingRow).toBeGreaterThanOrEqual(0);
		const click = (row: number, x: number): TuiMouseEvent => ({
			type: "click",
			button: "left",
			x,
			y: row,
			screenX: x,
			screenY: row,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		});

		expect(component.handleMouse(click(firstThinkingRow, 3))?.handled).toBe(true);
		expect(onToggle).toHaveBeenCalledTimes(1);

		const collapsed = stripAnsi(component.render(width).join("\n"));
		expect(collapsed).not.toContain("first reasoning");
		expect(collapsed).not.toContain("second reasoning");
		expect(collapsed.match(/Thought/g)).toHaveLength(2);

		const collapsedLines = component.render(width);
		const thoughtRow = collapsedLines.findIndex((line) => stripAnsi(line).includes("Thought"));
		expect(component.handleMouse(click(thoughtRow, 3))?.handled).toBe(true);
		expect(onToggle).toHaveBeenCalledTimes(2);

		const expanded = stripAnsi(component.render(width).join("\n"));
		expect(expanded).toContain("first reasoning");
		expect(expanded).toContain("second reasoning");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toContain(" hello");
		expect(lines).toContain("   reasoning");
		expect(lines.indexOf("   reasoning")).toBeGreaterThan(lines.indexOf(" Thought") + 1);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(updatedLines).toContain("hello");
		expect(updatedLines).toContain("  reasoning");
		expect(updatedLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders prose and fenced code blocks at full width", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "text",
					text:
						"Here is a short line.\n\n```js\n" +
						"const someVariable = computeSomething(initialValue, second);\n" +
						"const another = computeSomething(initialValue, second, third);\n```\n\n" +
						"After the code block.",
				},
			]),
		);
		const width = 80;
		const lines = component.render(width).map((line) => stripAnsi(line));
		const proseLines = lines.filter((line) => line.trimEnd().endsWith("Here is a short line."));
		expect(proseLines).toHaveLength(1);
		expect(proseLines[0].trimEnd()).toBe(" Here is a short line.");

		// Margin.
		const fenceOpen = lines.findIndex((line) => line.trim().startsWith("```js"));
		const fenceClose = lines.findIndex(
			(line, index) => index > fenceOpen && line.trim() === "```",
		);
		expect(fenceOpen).toBeGreaterThan(0);
		expect(fenceClose).toBeGreaterThan(fenceOpen);
		const codeLines = lines
			.slice(fenceOpen + 1, fenceClose)
			.filter((line) => line.trim().length > 0);
		expect(codeLines.length).toBeGreaterThan(0);
		expect(codeLines.some((line) => line.trim().startsWith("const "))).toBe(true);
		expect(codeLines.some((line) => line.includes("computeSomething"))).toBe(true);
		for (const codeLine of codeLines) {
			expect(codeLine.search(/\S/)).toBeGreaterThanOrEqual(1);
		}
		expect(lines.some((line) => line.includes("After the code block."))).toBe(true);
		const afterLine = lines.find((line) => line.includes("After the code block."))!;
		expect(afterLine.trimEnd().endsWith("After the code block.")).toBe(true);
		expect(afterLine.trimEnd()).toBe(" After the code block.");
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	test("renders code-only replies at full width", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "```js\nconst x = 1;\n```" }]),
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		const fenceOpen = lines.findIndex((line) => line.trim() === "```js");
		expect(fenceOpen).toBeGreaterThanOrEqual(0);
		for (const line of lines) {
			if (line.trim()) expect(line.search(/\S/)).toBeGreaterThanOrEqual(1);
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		expect(lines.some((line) => line.trimEnd().endsWith("const x = 1;"))).toBe(true);
	});

	test("keeps OSC 133 markers when prose reply contains code blocks", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "look:\n\n```js\nconst x = 1;\n```\n\ndone" },
			]),
		);
		const lines = component.render(80);

		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("keeps prose of tool-call messages at full width", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "Reading the file now." },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const width = 80;
		const lines = component.render(width).map((line) => stripAnsi(line));

		const proseLine = lines.find((line) => line.includes("Reading the file now."));
		expect(proseLine).toBeDefined();
		expect(proseLine!.trimEnd()).toBe(" Reading the file now.");

		// No markers.
		const rendered = lines.join("\n");
		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
	});

	test("streams prose and thinking at full width without reflowing on completion", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const prefixes = [
			"S",
			"Streaming",
			"Streaming text continues past the width of a single line and wraps onto another line.",
		];

		for (const text of prefixes) {
			component.updateContent(
				createAssistantMessage([
					{ type: "thinking", thinking: "Checking the answer" },
					{ type: "text", text },
				]),
				true,
			);
			const lines = component.render(32).map(stripAnsi);
			const fragment = text.slice(0, Math.min(5, text.length));
			expect(lines.find((line) => line.includes("Checking"))?.indexOf("Checking")).toBe(3);
			expect(lines.find((line) => line.includes("Checking"))).toContain("answer");
			expect(lines.find((line) => line.includes(fragment))?.indexOf(fragment)).toBe(1);
		}

		component.updateContent(
			createAssistantMessage([{ type: "text", text: prefixes.at(-1)! }]),
			false,
		);
		expect(
			component
				.render(32)
				.map(stripAnsi)
				.find((line) => line.includes("Stream"))
				?.indexOf("Stream"),
		).toBe(1);

		const hidden = new AssistantMessageComponent(undefined, true);
		hidden.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "Checking the answer" }]),
			true,
		);
		expect(
			hidden
				.render(32)
				.map(stripAnsi)
				.find((line) => line.includes("Thinking"))
				?.indexOf("Thinking"),
		).toBe(2);
	});

	test("renders a capital Thinking card while the model is thinking", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, true, undefined, "Thinking");
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]),
			true,
		);
		const lines = component.render(80);
		const card = lines.map(stripAnsi).join("\n");

		expect(card).toContain("Thinking 1s");
		expect(card).not.toContain("Thinking...");
		expect(lines.find((line) => stripAnsi(line).includes("Thinking"))).toContain(
			theme.getBgAnsi("userMessageBg"),
		);
	});

	test("counts thinking seconds and resolves to a duration", () => {
		initTheme("dark");
		vi.useFakeTimers();

		try {
			const requestRender = vi.fn();
			const message = createAssistantMessage([
				{ type: "thinking", thinking: "private reasoning" },
			]);
			const component = new AssistantMessageComponent(
				undefined,
				true,
				undefined,
				"Thinking",
				1,
				[],
				requestRender,
			);
			component.updateContent(message, true);

			vi.advanceTimersByTime(2600);
			const live = component.render(80).map(stripAnsi).join("\n");
			expect(live).toContain("Thinking 3s");
			expect(requestRender).toHaveBeenCalled();

			component.updateContent(message, false);
			vi.advanceTimersByTime(5000);
			const done = component.render(80).map(stripAnsi).join("\n");
			expect(done).toContain("Thought 3s");
			expect(done).not.toContain("Thinking");
			component.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("ends the thinking timer when the answer starts streaming", () => {
		initTheme("dark");
		vi.useFakeTimers();

		try {
			const component = new AssistantMessageComponent(undefined, true);
			component.updateContent(
				createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]),
				true,
			);
			vi.advanceTimersByTime(2100);
			component.updateContent(
				createAssistantMessage([
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "Here is the answer." },
				]),
				true,
			);
			vi.advanceTimersByTime(4000);

			const card = stripAnsi(component.render(80).join("\n"));
			expect(card).toContain("Thought 3s");
			expect(card).not.toContain("Thinking 7s");
			component.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not italicize the thinking card", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]),
			true,
		);
		const labelLine = component.render(80).find((line) => stripAnsi(line).includes("Thought"));

		expect(labelLine).toBeDefined();
		expect(labelLine).not.toContain("\x1b[3m");
	});

	test("preserves a custom thinking card label", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(undefined, true, undefined, "Pondering");
		component.updateContent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }]),
			true,
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Pondering");

		component.setHiddenThinkingLabel("Musing");
		const updated = stripAnsi(component.render(80).join("\n"));
		expect(updated).toContain("Musing");
		expect(updated).not.toContain("Pondering");
	});

	test(
		"keeps user prompts and streaming assistant replies in " + "the same centered column",
		() => {
			initTheme("dark");
			const column = new CenteredColumn(100);
			column.addChild(new UserMessageComponent("question"));
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(createAssistantMessage([{ type: "text", text: "answer" }]), true);
			column.addChild(assistant);

			const lines = column.render(160).map(stripAnsi);
			expect(lines.find((line) => line.includes("question"))?.indexOf("question")).toBe(31);
			expect(lines.find((line) => line.includes("answer"))?.indexOf("answer")).toBe(31);
		},
	);

	test("uses the full width when the terminal is too narrow for two columns", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
		);
		const lines = component.render(18).map(stripAnsi);
		expect(lines.find((line) => line.includes("answer"))?.indexOf("answer")).toBe(1);
		expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({
					messageType: "assistant",
					isStreaming: false,
					availableWidth: 78,
				});
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(
			undefined,
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					streamingStates.push(context.isStreaming);
					return context.isStreaming ? markdown : `${markdown} transformed`;
				},
			],
		);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating " + "the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line).trimEnd());
		expect(paddedLines).toContain(" hello");

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line).trimEnd());
		expect(unpaddedLines).toContain("hello");
	});
});
