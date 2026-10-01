import type { Component, TUI } from "@huranth/gama-tui";
import { parseColor } from "@huranth/gama-tui";
import { theme } from "../theme/theme.ts";

const GAMA_MARK_ROWS = [
	" ▄███████████",
	"██████████████",
	"█    ██   ████",
	"▀     █▄ ████",
	"      ██ ███",
	"       ████",
	"       ███",
	"       ██",
	"      ███",
	"    ▄███▄",
	"   ████▀",
	"  ▀██▀",
];

export const GAMA_ASCII_SKY_ROWS = 4;
export const GAMA_BAND_ROWS = 2;

export const GAMA_ASCII_ROWS = GAMA_MARK_ROWS;
export const GAMA_ASCII_HEIGHT = GAMA_ASCII_ROWS.length;
export const GAMA_ASCII_TOTAL_ROWS = GAMA_ASCII_SKY_ROWS + GAMA_ASCII_HEIGHT;
export const GAMA_ASCII_WIDTH = Math.max(0, ...GAMA_ASCII_ROWS.map((row) => [...row].length));

export const GAMA_BAND_HEX = ["#4B5263", "#5E6577", "#767E93", "#9298AD", "#B6BBC9", "#E4E7EE"];

const GAMA_BAND_COLORS = GAMA_BAND_HEX.map((hex) => parseColor(hex));

const INTERVAL_MS = 60;
const DROP_TICKS = 10;
const DROP_STAGGER = DROP_TICKS;
const DROP_HEIGHT = GAMA_ASCII_TOTAL_ROWS;
const SWEEP_SPAN = GAMA_ASCII_WIDTH + 12;
const DROP_END = (GAMA_BAND_HEX.length - 1) * DROP_STAGGER + DROP_TICKS;

const OUTRO_TICKS = 5;
const OUTRO_STAGGER = 3;
const OUTRO_TOTAL = (GAMA_BAND_HEX.length - 1) * OUTRO_STAGGER + OUTRO_TICKS;

export function gamaAsciiBandOfRow(gridRow: number): number {
	return Math.min(
		GAMA_BAND_HEX.length - 1,
		Math.floor((GAMA_ASCII_HEIGHT - 1 - gridRow) / GAMA_BAND_ROWS),
	);
}

export function gamaAsciiBandOffset(band: number, tick: number): number {
	const progress = Math.min(1, Math.max(0, (tick - band * DROP_STAGGER) / DROP_TICKS));
	if (progress >= 1) return 0;

	const remaining = 1 - progress;
	return -Math.round(DROP_HEIGHT * remaining * remaining);
}

export class GamaAsciiLogo implements Component {
	private readonly ui: TUI;
	private timer: NodeJS.Timeout | null = null;
	private tick = 0;
	private settled = false;
	private dismissing = false;
	private dismissed = false;
	private outroTick = 0;
	private startOffsets: number[] = [];
	private onDismissed: (() => void) | undefined;

	constructor(ui: TUI) {
		this.ui = ui;
		this.timer = setInterval(() => this.advance(), INTERVAL_MS);
	}

	private advance(): void {
		if (this.dismissing) {
			this.outroTick += 1;

			if (this.outroTick >= OUTRO_TOTAL) {
				this.dismissing = false;
				this.dismissed = true;
				this.stop();

				const done = this.onDismissed;
				this.onDismissed = undefined;
				done?.();
			}

			this.ui.requestRender();
			return;
		}

		this.tick += 1;
		if (this.tick - DROP_END >= SWEEP_SPAN) {
			this.settled = true;
			this.stop();
		}

		this.ui.requestRender();
	}

	// Dismiss drop.
	beginDismiss(onDone?: () => void): void {
		if (this.dismissing || this.dismissed) return;

		this.startOffsets = GAMA_BAND_HEX.map((_, band) => this.courseOffset(band));
		this.onDismissed = onDone;
		this.dismissing = true;
		this.outroTick = 0;

		if (!this.timer) {
			this.timer = setInterval(() => this.advance(), INTERVAL_MS);
		}

		this.ui.requestRender();
	}

	// Stop timer.
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	get isSettled(): boolean {
		return this.settled;
	}

	get isDismissed(): boolean {
		return this.dismissed;
	}

	invalidate(): void {}

	private courseOffset(band: number): number {
		if (this.dismissed) {
			return -DROP_HEIGHT;
		}
		if (!this.dismissing) {
			return gamaAsciiBandOffset(band, this.tick);
		}
		const start = this.startOffsets[band] ?? 0;
		const bandTick = (GAMA_BAND_HEX.length - 1 - band) * OUTRO_STAGGER;
		const progress = Math.min(1, Math.max(0, (this.outroTick - bandTick) / OUTRO_TICKS));
		if (progress >= 1) return -DROP_HEIGHT;

		// Whole rows.
		return Math.round(start + (-DROP_HEIGHT - start) * progress * progress);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(0, Math.floor(width));
		if (safeWidth < GAMA_ASCII_WIDTH) return [];

		const centerPad = " ".repeat(Math.max(0, Math.floor((safeWidth - GAMA_ASCII_WIDTH) / 2)));
		const dropping = !this.settled && this.tick < DROP_END;
		const sweepTick = this.tick - DROP_END;
		const band = this.settled || dropping ? Number.NaN : sweepTick - 6;

		// Reset background.
		const NO_BACKGROUND = "\x1b[49m";
		const lines: string[] = [];

		for (let row = 0; row < GAMA_ASCII_TOTAL_ROWS; row++) {
			let line = "";
			// Grid row.
			const gridRow = row - GAMA_ASCII_SKY_ROWS;
			for (let x = 0; x < GAMA_ASCII_WIDTH; x++) {
				let cell = " ";
				let course = -1;
				for (let candidate = 0; candidate < GAMA_BAND_HEX.length; candidate++) {
					const offset = this.courseOffset(candidate);
					const source = gridRow - offset;
					if (
						source < 0 ||
						source >= GAMA_ASCII_HEIGHT ||
						gamaAsciiBandOfRow(source) !== candidate
					) {
						continue;
					}
					const ink = GAMA_ASCII_ROWS[source]?.[x] ?? " ";
					if (ink !== " ") {
						cell = ink;
						course = candidate;
						break;
					}
				}
				if (cell === " ") {
					line += " ";
					continue;
				}
				const courseColor = course === -1 ? undefined : GAMA_BAND_COLORS[course];
				const paint =
					courseColor === undefined
						? theme.fg("text", cell)
						: theme.style(cell, { fg: courseColor });

				const highlighted = !Number.isNaN(band) && Math.abs(x - band) <= 1;
				line += highlighted ? theme.fg("dim", cell) : paint;
			}
			lines.push(line.trim() === "" ? "" : NO_BACKGROUND + centerPad + line);
		}

		return lines;
	}
}
