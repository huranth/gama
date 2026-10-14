import { describe, expect, it } from "vitest";
import {
	DEFAULT_PACER_OPTIONS,
	revealRows,
	rowsVisibleWidth,
	StreamPacer,
	type StreamPacerOptions,
} from "../src/modes/tui/stream-pacer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const FRAME = DEFAULT_PACER_OPTIONS.frameMs;
// Clock.
const START = 0;

function makePacer(options: StreamPacerOptions = {}): StreamPacer {
	return new StreamPacer(options, START);
}

// Frames.
function runFrames(pacer: StreamPacer, frames: number, startAt = 0): number[] {
	const trace: number[] = [];
	let now = startAt;
	for (let i = 0; i < frames; i++) {
		now += FRAME;
		pacer.advance(now);
		trace.push(pacer.revealedUnits);
	}
	return trace;
}

describe("StreamPacer target handling", () => {
	it("never reveals more than has been produced", () => {
		const pacer = makePacer();
		pacer.setTarget(10);

		const trace = runFrames(pacer, 20);

		expect(Math.max(...trace)).toBe(10);
		expect(pacer.revealedUnits).toBe(10);
	});

	it("ignores a shrinking target so the reveal only ever grows", () => {
		const pacer = makePacer();
		pacer.setTarget(400);
		pacer.advance(START + FRAME);
		const afterFirstFrame = pacer.revealedUnits;

		pacer.setTarget(3);

		expect(pacer.targetUnits).toBe(400);
		expect(pacer.revealedUnits).toBeGreaterThanOrEqual(afterFirstFrame);
	});

	it("parks at the watermark while the producer stalls, then resumes", () => {
		const pacer = makePacer();
		pacer.setTarget(30);

		runFrames(pacer, 10);
		const parked = pacer.revealedUnits;
		expect(parked).toBe(30);
		expect(pacer.isDraining).toBe(false);

		const idle = runFrames(pacer, 5, 10 * FRAME);
		expect(idle.every((value) => value === parked)).toBe(true);

		pacer.setTarget(200);
		expect(pacer.isDraining).toBe(true);
		const resumed = runFrames(pacer, 40, 15 * FRAME);
		expect(resumed[0]).toBeGreaterThan(parked);
		expect(pacer.revealedUnits).toBe(200);
	});
});

describe("StreamPacer pacing shape", () => {
	it("produces a monotonic reveal so rows only grow", () => {
		const pacer = makePacer();
		pacer.setTarget(5000);

		const trace = runFrames(pacer, 200);

		for (let i = 1; i < trace.length; i++) {
			expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1]);
		}
	});

	it("keeps up with a provider streaming slower than the base rate", () => {
		const pacer = makePacer();

		let produced = 0;
		const trace: number[] = [];
		for (let i = 0; i < 10; i++) {
			produced += 8;
			pacer.setTarget(produced);
			pacer.advance(START + i * FRAME + FRAME);
			trace.push(pacer.revealedUnits);
		}

		for (const [index, revealed] of trace.entries()) {
			expect(revealed).toBeGreaterThan(0);
			expect(revealed).toBeLessThanOrEqual((index + 1) * 8);
			expect(pacer.pendingUnits).toBeLessThanOrEqual(8);
		}
	});

	it("bounds the lag on a burst instead of letting it scale with the burst", () => {
		const small = makePacer();
		small.setTarget(600);
		small.advance(START + FRAME);
		const smallStep = small.revealedUnits;

		const large = makePacer();
		large.setTarget(60_000);
		large.advance(START + FRAME);
		const largeStep = large.revealedUnits;

		expect(largeStep).toBeLessThanOrEqual(DEFAULT_PACER_OPTIONS.maxUnitsPerFrame);
		expect(largeStep / smallStep).toBeLessThan(10);
	});

	it("never paints a whole body in a single frame, however big it is", () => {
		const pacer = makePacer();
		const body = 100_000;
		pacer.setTarget(body);

		pacer.advance(START + FRAME);

		expect(pacer.revealedUnits).toBeLessThan(body);
		expect(pacer.revealedUnits).toBeLessThanOrEqual(DEFAULT_PACER_OPTIONS.maxUnitsPerFrame);
		expect(pacer.isDraining).toBe(true);
	});

	it("drains a burst far faster than the base rate would", () => {
		const pacer = makePacer();
		const body = 1800;
		pacer.setTarget(body);

		let frames = 0;
		while (pacer.isDraining && frames < 500) {
			frames += 1;
			pacer.advance(START + frames * FRAME);
		}

		expect(pacer.revealedUnits).toBe(body);
		expect(frames).toBeLessThan(35);
	});

	it("does not repay a long stall as one giant frame", () => {
		const pacer = makePacer();
		pacer.setTarget(5000);
		pacer.advance(START + FRAME);

		const before = pacer.revealedUnits;
		pacer.advance(START + FRAME + 10_000);

		const step = pacer.revealedUnits - before;
		expect(step).toBeLessThanOrEqual(DEFAULT_PACER_OPTIONS.maxUnitsPerFrame * 4);
	});

	it("jumps to the end only when explicitly asked", () => {
		const pacer = makePacer();
		pacer.setTarget(900);
		expect(pacer.isDraining).toBe(true);

		pacer.finish();

		expect(pacer.revealedUnits).toBe(900);
		expect(pacer.isDraining).toBe(false);
	});
});

describe("revealRows", () => {
	const rows = ["const alpha = 1;", "const beta = 2;", "const gamma = 3;"];
	const firstRow = rows[0] ?? "";
	const secondRow = rows[1] ?? "";

	it("shows nothing for an empty budget", () => {
		expect(revealRows(rows, 0)).toEqual([]);
	});

	it("shows whole rows once the budget covers them", () => {
		const width = rowsVisibleWidth([firstRow]);
		expect(revealRows(rows, width)).toEqual([firstRow]);
		expect(revealRows(rows, width * 2)).toEqual([firstRow, secondRow]);
	});

	it("shows everything once the budget exceeds the block", () => {
		expect(revealRows(rows, rowsVisibleWidth(rows))).toEqual(rows);
		expect(revealRows(rows, 10_000)).toEqual(rows);
	});

	it("does not open a second row just to cut it mid-word", () => {
		expect(revealRows(rows, 20)).toEqual([firstRow]);
	});

	it("reveals word by word as the budget grows", () => {
		const seen: string[] = [];
		for (let budget = 1; budget <= 18; budget++) {
			seen.push(revealRows(rows, budget)[0] ?? "");
		}

		for (const state of seen) {
			expect(firstRow.startsWith(state)).toBe(true);
			const next = firstRow.slice(state.length, state.length + 1);
			expect(state === "" || next === "" || next === " ").toBe(true);
		}
		expect(new Set(seen).size).toBeGreaterThan(1);
		expect(seen).toContain("const");
		expect(seen).toContain("const alpha");
	});

	it("measures styled rows by visible width, not escape bytes", () => {
		const styled = ["\u001b[31mconst alpha = 1;\u001b[39m"];
		expect(rowsVisibleWidth(styled)).toBe(firstRow.length);
		expect(revealRows(styled, firstRow.length)).toEqual(styled);
	});

	it("keeps the styling of a partially revealed row", () => {
		const styled = ["\u001b[31mconst alpha = 1;\u001b[39m"];
		const partial = revealRows(styled, 8);

		expect(partial).toHaveLength(1);
		expect(partial[0]).toContain("\u001b[31m");
		expect(stripAnsi(partial[0] ?? "")).toBe("const");
	});

	it("slices a row that is one unbroken token rather than freezing it", () => {
		const blob = ["\u001b[32mAAAAAAAABBBBBBBBCCCCCCCC\u001b[39m"];
		const partial = revealRows(blob, 8);

		expect(partial).toHaveLength(1);
		expect(partial[0]).toContain("\u001b[32m");
		expect(stripAnsi(partial[0] ?? "")).toBe("AAAAAAAA");
	});

	it("can be told to cut raw, ignoring word boundaries", () => {
		const raw = revealRows(rows, 3, { snapToWord: false });
		expect(raw).toHaveLength(1);
		expect(stripAnsi(raw[0] ?? "")).toBe("con");
	});
});
