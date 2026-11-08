import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/term/parts/user-message.ts";
import { initTheme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const ZONE_PATTERN = /\x1b\]133;[ABC]\x07/g;

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripAnsi(line).replace(ZONE_PATTERN, ""));
}

describe("UserMessageComponent", () => {
	test("renders the prompt band with its breathing room", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = visibleLines(component.render(20)).map((line) => line.trimEnd());
		const text = lines.join("\n");

		expect(text).toContain("hello");
		expect(text).not.toContain("qui");
		expect(lines).toHaveLength(5);
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe(" hello");
		expect(lines[3]).toBe("");
		expect(lines[4]).toBe("");
	});

	test("keeps the OSC markers around the prompt", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(40);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]?.startsWith(OSC133_ZONE_START)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines.at(-1)?.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("renders every prompt line", () => {
		initTheme("dark");

		const component = new UserMessageComponent("first line\n\nsecond line");
		const text = visibleLines(component.render(40)).join("\n");

		expect(text).toContain("first line");
		expect(text).toContain("second line");
		expect(text.indexOf("first line")).toBeLessThan(text.indexOf("second line"));
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
