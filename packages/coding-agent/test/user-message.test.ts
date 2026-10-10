import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/tui/parts/user-message.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const ZONE_PATTERN = /\x1b\]133;[ABC]\x07/g;

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripAnsi(line).replace(ZONE_PATTERN, ""));
}

describe("UserMessageComponent", () => {
	test("renders a left-aligned prompt wrapped in OSC 133 zone markers", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines[0].startsWith(OSC133_ZONE_START)).toBe(true);
		expect(lines[lines.length - 1]).toContain(OSC133_ZONE_END + OSC133_ZONE_FINAL);
		expect(lines.join("\n")).toContain("hello");
		const plain = visibleLines(lines)
			.filter((line) => line.trim().length > 0)
			.map((line) => line.trimEnd());
		expect(plain).toHaveLength(1);
		expect(plain[0]).toBe(" hello");
	});

	test("keeps the closing OSC markers off the final line of multi-line messages", () => {
		initTheme("dark");

		const component = new UserMessageComponent("first line\n\nsecond line");
		const lines = component.render(40);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0].startsWith(OSC133_ZONE_START)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("renders multi-line prompts flush-left with no right shift", () => {
		initTheme("dark");

		const component = new UserMessageComponent("first line\n\nsecond line");
		const plain = visibleLines(component.render(40))
			.filter((line) => line.trim().length > 0)
			.map((line) => line.trimEnd());

		expect(plain[0]).toBe(" first line");
		expect(plain[plain.length - 1]).toBe(" second line");
		for (const line of plain) {
			expect(line.startsWith(" ")).toBe(true);
		}
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({
					messageType: "user",
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

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [
			(markdown) => `${markdown} ${suffix}`,
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});
});
