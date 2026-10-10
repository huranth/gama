import { describe, expect, it } from "vitest";
import { truncateToVisualLines } from "../src/modes/tui/parts/visual-truncate.ts";

describe("truncateToVisualLines", () => {
	it("renders nothing when the limit is zero", () => {
		const result = truncateToVisualLines("one\ntwo\nthree", 0, 40);

		expect(result.visualLines).toEqual([]);
		expect(result.skippedCount).toBe(3);
	});

	it("keeps the last lines by default", () => {
		const result = truncateToVisualLines("one\ntwo\nthree", 2, 40);

		expect(result.visualLines.map((line) => line.trim())).toEqual(["two", "three"]);
		expect(result.skippedCount).toBe(1);
	});

	it("keeps the first lines when asked", () => {
		const result = truncateToVisualLines("one\ntwo\nthree", 2, 40, 0, "start");

		expect(result.visualLines.map((line) => line.trim())).toEqual(["one", "two"]);
		expect(result.skippedCount).toBe(1);
	});
});
