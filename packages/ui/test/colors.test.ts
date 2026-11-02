import assert from "node:assert";
import { describe, it } from "node:test";
import {
	colorToHex,
	colorToOkhsl,
	colorToRgb,
	indexedColor,
	okhslColor,
	oklchColor,
	parseColor,
	rgbColor,
	styleText,
} from "../src/index.ts";

describe("colors", () => {
	it("parses hex and OKLCH colors and rejects everything else", () => {
		assert.deepStrictEqual(parseColor("#abc"), { kind: "rgb", r: 170, g: 187, b: 204 });
		assert.deepStrictEqual(parseColor("oklch(62% 0.1 200)"), {
			kind: "oklch",
			l: 0.62,
			c: 0.1,
			h: 200,
		});
		assert.throws(() => parseColor(""), /Bad color/);
		assert.throws(() => parseColor("red"), /Bad color/);
	});

	it("gamut-maps OKLCH to sRGB, including the lightness limits", () => {
		assert.deepStrictEqual(colorToRgb(oklchColor(0.627955, 0.257683, 29.2339)), {
			r: 255,
			g: 0,
			b: 0,
		});
		assert.deepStrictEqual(colorToRgb(oklchColor(1, 0.3, 150)), { r: 255, g: 255, b: 255 });
		assert.deepStrictEqual(colorToRgb(oklchColor(0, 0.3, 150)), { r: 0, g: 0, b: 0 });
	});

	it("parses OKHSL colors and round-trips them", () => {
		assert.deepStrictEqual(parseColor("okhsl(29.23 100% 56.8%)"), rgbColor(255, 0, 0));
		assert.deepStrictEqual(parseColor("OKHSL(250deg 60% 55%)"), okhslColor(250, 0.6, 0.55));
		assert.throws(() => parseColor("okhsl(250 160% 55%)"), /Bad value/);
		for (const hex of ["#4f8eb3", "#20242a", "#f8f9fa"]) {
			const { h, s, l } = colorToOkhsl(parseColor(hex));
			assert.strictEqual(colorToHex(okhslColor(h, s, l)), hex);
		}
	});

	it("names the offending channel when a value is not finite", () => {
		assert.throws(() => rgbColor(Number.NaN, 0, 0), /Bad value for r: NaN/);
		assert.throws(() => rgbColor(0, Number.POSITIVE_INFINITY, 0), /Bad value for g: Infinity/);
		assert.throws(() => oklchColor(0.5, Number.NaN, 0), /Bad value for c: NaN/);
		assert.throws(() => okhslColor(0, Number.NaN, 0.5), /Bad value for s: NaN/);
	});

	it("styles text and closes sequences in reverse order", () => {
		assert.strictEqual(
			styleText(
				"Ready",
				{ fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true },
				"truecolor",
			),
			"\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m",
		);
		assert.match(
			styleText("Ready", { fg: rgbColor(18, 52, 86) }, "256color"),
			/^\x1b\[38;5;\d+mReady\x1b\[39m$/,
		);
	});
});
