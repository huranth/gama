import type { Component } from "../screen.ts";
import { clampPaddingX, padLine, truncateToWidth } from "../utils.ts";

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
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth === 0) return [];
		const emptyLine = " ".repeat(safeWidth);
		const padding = Array.from({ length: this.paddingY }, () => emptyLine);
		const paddingX = this.clampPadding(safeWidth);
		const availableWidth = Math.max(1, safeWidth - paddingX * 2);
		const displayText = truncateToWidth(this.firstLine(), availableWidth);
		const margin = " ".repeat(paddingX);
		const lineWithPadding = margin + displayText + margin;

		return [...padding, padLine(lineWithPadding, safeWidth), ...padding];
	}

	private clampPadding(width: number): number {
		return clampPaddingX(width, this.paddingX);
	}

	private firstLine(): string {
		// CRLF guard
		const newline = /\r\n|\r|\n/.exec(this.text);
		return newline ? this.text.slice(0, newline.index) : this.text;
	}
}
