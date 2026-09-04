import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export class TruncatedText implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		const padding = Array.from({ length: this.paddingY }, () => emptyLine);
		const paddingX = this.clampPadding(width);
		const availableWidth = Math.max(1, width - paddingX * 2);
		const displayText = truncateToWidth(this.firstLine(), availableWidth);
		const margin = " ".repeat(paddingX);
		const lineWithPadding = margin + displayText + margin;
		const paddingNeeded = Math.max(0, width - visibleWidth(lineWithPadding));

		return [...padding, lineWithPadding + " ".repeat(paddingNeeded), ...padding];
	}

	private clampPadding(width: number): number {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		return Math.min(this.paddingX, maxPadding);
	}

	private firstLine(): string {
		const newlineIndex = this.text.indexOf("\n");
		if (newlineIndex === -1) return this.text;
		return this.text.substring(0, newlineIndex);
	}
}
