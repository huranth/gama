import type { TUI } from "@huranth/gama-tui";

const MS_PER_SECOND = 1000;

export class CountdownTimer {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private remainingSeconds: number;
	private tui: TUI | undefined;
	private onTick: (seconds: number) => void;
	private onExpire: () => void;

	constructor(
		timeoutMs: number,
		tui: TUI | undefined,
		onTick: (seconds: number) => void,
		onExpire: () => void,
	) {
		this.tui = tui;
		this.onTick = onTick;
		this.onExpire = onExpire;
		this.remainingSeconds = Math.ceil(timeoutMs / MS_PER_SECOND);
		this.onTick(this.remainingSeconds);

		this.intervalId = setInterval(() => {
			if (!this.intervalId) return;

			this.remainingSeconds--;
			this.onTick(this.remainingSeconds);
			this.tui?.requestRender();

			if (this.remainingSeconds <= 0) {
				this.dispose();
				this.onExpire();
			}
		}, MS_PER_SECOND);
		this.intervalId.unref?.();
	}

	dispose(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
