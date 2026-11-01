import type { TUI } from "../screen.ts";
import { Text } from "./text.ts";

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DEFAULT_INTERVAL_MS = 80;

const DEFAULT_MESSAGE = "Loading...";

export interface LoaderIndicatorOptions {
	frames?: string[];
	intervalMs?: number;
}

export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	private message: string = DEFAULT_MESSAGE;
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;
	private spinnerColorFn: (str: string) => string;
	private messageColorFn: (str: string) => string;

	constructor(
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string = DEFAULT_MESSAGE,
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		this.spinnerColorFn = spinnerColorFn;
		this.messageColorFn = messageColorFn;
		this.message = message;
		this.setIndicator(indicator);
	}

	start(): void {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop(): void {
		if (!this.intervalId) return;

		clearInterval(this.intervalId);
		this.intervalId = null;
	}

	setMessage(message: string): void {
		this.message = message;
		this.updateDisplay();
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = [...(indicator?.frames ?? DEFAULT_FRAMES)];

		const interval = indicator?.intervalMs;
		this.intervalMs = interval !== undefined && interval > 0 ? interval : DEFAULT_INTERVAL_MS;

		this.currentFrame = 0;
		this.start();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	protected getRenderedIndicator(): string {
		const frame = this.frames[this.currentFrame] ?? "";
		return this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1) return;

		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, this.intervalMs);
		this.intervalId.unref?.();
	}

	private updateDisplay(): void {
		const renderedFrame = this.getRenderedIndicator();
		const indicator = renderedFrame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.messageColorFn(this.message)}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}
}
