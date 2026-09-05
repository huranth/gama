const BURST_GAP_MS = 5;

const GESTURE_GAP_MS = 200;

const REFERENCE_GAP_MS = 100;

const MAX_AUTO_LINES = 6;

function terminalAcceleratesWheel(): boolean {
	const env = process.env;
	const isLocalShell =
		env.SSH_CONNECTION === undefined && env.SSH_CLIENT === undefined && env.SSH_TTY === undefined;

	return process.platform === "darwin" && isLocalShell;
}

export type WheelScrollLines = number | "auto";

export class WheelScrollAccelerator {
	private lines: WheelScrollLines;
	private readonly accelerate: boolean;
	private lastTime = Number.NEGATIVE_INFINITY;
	private lastDirection = 0;
	private averageGap: number | undefined;
	private carry = 0;

	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		this.lines = lines;
		this.accelerate = accelerate;
	}

	setLines(lines: WheelScrollLines): void {
		this.lines = lines;
		this.reset();
	}

	next(direction: -1 | 1, now: number): number {
		if (this.lines !== "auto") return this.fixedLines();
		if (!this.accelerate) return 1;

		const gap = now - this.lastTime;
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;

		this.lastTime = now;
		this.lastDirection = direction;

		if (!sameGesture) {
			this.averageGap = undefined;
			this.carry = 0;
			return 1;
		}

		if (gap < BURST_GAP_MS) return 1;

		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;

		const speed = REFERENCE_GAP_MS / this.averageGap;
		const lines = Math.min(MAX_AUTO_LINES, Math.max(1, speed)) + this.carry;
		const whole = Math.floor(lines);

		this.carry = lines - whole;

		return whole;
	}

	private fixedLines(): number {
		if (this.lines === "auto") return 1;
		if (!Number.isFinite(this.lines)) return 1;

		return Math.max(1, Math.floor(this.lines));
	}

	private reset(): void {
		this.lastTime = Number.NEGATIVE_INFINITY;
		this.lastDirection = 0;
		this.averageGap = undefined;
		this.carry = 0;
	}
}
