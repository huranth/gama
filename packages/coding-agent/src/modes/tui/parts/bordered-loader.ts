import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@huranth/gama-tui";
import type { Theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export class BorderedLoader extends Container {
	private loader: CancellableLoader | Loader;
	private cancellable: boolean;
	private signalController?: AbortController;

	constructor(tui: TUI, theme: Theme, message: string, options?: { cancellable?: boolean }) {
		super();

		this.cancellable = options?.cancellable ?? true;

		const borderColor = (text: string) => theme.fg("border", text);
		const spinnerColor = (text: string) => theme.fg("accent", text);
		const messageColor = (text: string) => theme.fg("muted", text);

		this.addChild(new DynamicBorder(borderColor));

		if (this.cancellable) {
			this.loader = new CancellableLoader(tui, spinnerColor, messageColor, message);
		} else {
			this.signalController = new AbortController();
			this.loader = new Loader(tui, spinnerColor, messageColor, message);
		}

		this.addChild(this.loader);

		if (this.cancellable) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		}

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	get signal(): AbortSignal {
		if (this.cancellable) {
			return this.cancellableLoader.signal;
		}

		return this.signalController?.signal ?? new AbortController().signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		if (this.cancellable) {
			this.cancellableLoader.onAbort = fn;
		}
	}

	handleInput(data: string): void {
		if (this.cancellable) {
			this.cancellableLoader.handleInput(data);
		}
	}

	dispose(): void {
		const loader = this.loader as { dispose?: () => void; stop?: () => void };

		if (typeof loader.dispose === "function") {
			loader.dispose();
			return;
		}

		loader.stop?.();
	}

	private get cancellableLoader(): CancellableLoader {
		return this.loader as CancellableLoader;
	}
}
