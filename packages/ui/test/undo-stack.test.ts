import assert from "node:assert";
import { describe, it } from "node:test";
import { MAX_UNDO_DEPTH, UndoStack } from "../src/undo-stack.ts";

describe("UndoStack", () => {
	it("caps depth and drops the oldest snapshots", () => {
		const stack = new UndoStack<{ n: number }>();
		for (let n = 0; n < MAX_UNDO_DEPTH + 50; n++) stack.push({ n });

		assert.strictEqual(stack.length, MAX_UNDO_DEPTH);
		assert.strictEqual(stack.pop()?.n, MAX_UNDO_DEPTH + 49);
		let last: { n: number } | undefined;
		for (let s = stack.pop(); s; s = stack.pop()) last = s;
		assert.strictEqual(last?.n, 50);
	});
});
