import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyBackgroundToLine, closeBeforePadding, padLine, visibleWidth } from "../src/utils.ts";

const BG_OPEN = "\x1b[48;2;10;20;30m";
const BG_CLOSE = "\x1b[49m";

describe("padding never inherits a drawing style", () => {
	it("closes underline and OSC8 before the fill", () => {
		const line = "\x1b[4m\x1b]8;;https://example.com\x07x";
		const out = padLine(line, 6);
		const firstSpace = out.indexOf(" ", line.length);
		assert.ok(firstSpace > line.length, "fill starts after the content");
		assert.ok(
			out.lastIndexOf("\x1b[24m", firstSpace) >= line.length,
			"underline closed before fill",
		);
		assert.ok(
			out.lastIndexOf("\x1b]8;;\x07", firstSpace) >= line.length,
			"link closed before fill",
		);
		assert.equal(visibleWidth(out), 6);
	});

	it("keeps a background open across the fill", () => {
		const out = applyBackgroundToLine("\x1b[3mx", 8, (text) => `${BG_OPEN}${text}${BG_CLOSE}`);
		assert.ok(out.startsWith(`${BG_OPEN}\x1b[3mx`), "background opens before content");
		assert.ok(out.includes("\x1b[24m"), "underline is closed before the fill");
		assert.ok(out.endsWith(BG_CLOSE), "background closes at the end");
		assert.equal(visibleWidth(out), 8);
	});

	it("only emits a close when there is padding to protect", () => {
		assert.equal(padLine("abc", 3), "abc");
		assert.equal(padLine("abc", 6), "abc   ");
		assert.equal(closeBeforePadding("plain"), "");
		assert.equal(closeBeforePadding("\x1b[0m").includes("\x1b[24m"), true);
	});
});
