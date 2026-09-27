import { truncateToWidth, visibleWidth } from "@huranth/gama-tui";
import { stripAnsi } from "../../utils/ansi.ts";

export interface StreamPacerOptions {
	baseUnitsPerSecond?: number;
	backlogWindowUnits?: number;
	catchUpFrames?: number;
	frameMs?: number;
	maxUnitsPerFrame?: number;
}

export const DEFAULT_PACER_OPTIONS: Required<StreamPacerOptions> = {
	baseUnitsPerSecond: 600,
	backlogWindowUnits: 90,
	catchUpFrames: 4,
	frameMs: 16,
	maxUnitsPerFrame: 480,
};

export const PACER_FRAME_MS = DEFAULT_PACER_OPTIONS.frameMs;

// Elapsed cap.
const MAX_ELAPSED_FRAMES = 4;

const TRUNCATION_RESET = "\u001b[0m";

export function rowsVisibleWidth(rows: readonly string[]): number {
	let total = 0;
	for (const row of rows) {
		total += visibleWidth(row);
	}
	return total;
}

function snapToWordEnd(plain: string, width: number): number {
	const index = Math.min(width, plain.length);
	let boundary = index;

	while (boundary > 0 && !/\s/.test(plain[boundary - 1] ?? "")) {
		boundary -= 1;
	}

	if (boundary > 0) return boundary - 1;
	// Word boundary.
	if (index < plain.length && /\s/.test(plain[index] ?? "")) return index;

	return /\s/.test(plain) ? 0 : index;
}

export function revealRows(
	rows: readonly string[],
	revealedChars: number,
	options: { snapToWord?: boolean } = {},
): string[] {
	const budget = Math.max(0, Math.floor(revealedChars));
	const snapToWord = options.snapToWord !== false;
	const out: string[] = [];
	let used = 0;

	for (const row of rows) {
		if (used >= budget) break;

		const width = visibleWidth(row);
		if (used + width <= budget) {
			out.push(row);
			used += width;
			continue;
		}

		const remaining = budget - used;
		const cut = snapToWord ? snapToWordEnd(stripAnsi(row), remaining) : remaining;
		if (cut <= 0) break;

		out.push(truncateRevealedRow(row, cut));
		break;
	}

	return out;
}

function truncateRevealedRow(row: string, cut: number): string {
	const truncated = truncateToWidth(row, cut, "");
	if (row.endsWith(TRUNCATION_RESET) || !truncated.endsWith(TRUNCATION_RESET)) return truncated;

	return truncated.slice(0, -TRUNCATION_RESET.length);
}

export class StreamPacer {
	private readonly options: Required<StreamPacerOptions>;
	private produced = 0;
	private shown = 0;
	private advancedAt: number;

	constructor(options: StreamPacerOptions = {}, now = Date.now()) {
		this.options = { ...DEFAULT_PACER_OPTIONS, ...options };
		this.advancedAt = now;
	}

	get targetUnits(): number {
		return this.produced;
	}

	get revealedUnits(): number {
		return Math.floor(this.shown);
	}

	get pendingUnits(): number {
		return Math.max(0, this.produced - Math.floor(this.shown));
	}

	get isDraining(): boolean {
		return this.pendingUnits > 0;
	}

	setTarget(units: number): void {
		const next = Math.max(0, Math.floor(units));
		if (next > this.produced) this.produced = next;
	}

	advance(now = Date.now()): boolean {
		const pending = this.pendingUnits;
		if (pending <= 0) {
			this.advancedAt = now;
			return false;
		}

		const elapsed = Math.min(
			Math.max(0, now - this.advancedAt),
			this.options.frameMs * MAX_ELAPSED_FRAMES,
		);
		this.advancedAt = now;
		const frames = Math.max(elapsed / this.options.frameMs, 1);

		const baseStep = (this.options.baseUnitsPerSecond * elapsed) / 1000;
		const excess = Math.max(0, pending - this.options.backlogWindowUnits);
		const catchUpStep = (excess / this.options.catchUpFrames) * frames;
		const step = Math.min(
			baseStep + catchUpStep,
			this.options.maxUnitsPerFrame * frames,
			pending,
		);
		if (step <= 0) return false;

		this.shown += step;
		if (this.shown > this.produced) this.shown = this.produced;
		return true;
	}

	finish(): void {
		this.shown = this.produced;
	}

	reset(now = Date.now()): void {
		this.produced = 0;
		this.shown = 0;
		this.advancedAt = now;
	}
}
