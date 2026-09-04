import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

interface FlashEntry {
	id: number;
	message: string;
	timer: NodeJS.Timeout;
}

const DEFAULT_DURATION_MS = 1000;

export class AltScreenFlashContainer implements Component {
	private readonly entries: FlashEntry[] = [];
	private nextId = 0;
	private readonly requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	flash(message: string, durationMs = DEFAULT_DURATION_MS): void {
		const id = this.nextId++;
		const timer = setTimeout(() => this.removeEntry(id), Math.max(0, durationMs));
		timer.unref();
		this.entries.push({ id, message, timer });
		this.requestRender();
	}

	dispose(): void {
		for (const entry of this.entries) {
			clearTimeout(entry.timer);
		}
		this.entries.length = 0;
	}

	invalidate(): void {}

	private removeEntry(id: number): void {
		const index = this.entries.findIndex((entry) => entry.id === id);
		if (index === -1) return;
		this.entries.splice(index, 1);
		this.requestRender();
	}

	render(width: number): string[] {
		return this.entries.map((entry) => {
			const message = truncateToWidth(` ${entry.message} `, width, "");
			return `\x1b[7m${message}\x1b[27m`;
		});
	}
}
