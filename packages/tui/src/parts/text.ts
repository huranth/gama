import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

export class Text implements Component {
	private text: string;
	private paddingX: number;
	private paddingY: number;
	private customBgFn?: (text: string) => string;

	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string = "",
		paddingX: number = 1,
		paddingY: number = 1,
		customBgFn?: (text: string) => string,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		this.text = text;
		this.clearCache();
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.clearCache();
	}

	invalidate(): void {
		this.clearCache();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		if (!this.text.trim()) {
			return this.cacheResult([], width);
		}

		const normalizedText = this.text.replace(/\t/g, "   ");
		const paddingX = this.clampPadding(width);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const contentLines = this.buildContentLines(normalizedText, contentWidth, width, paddingX);
		const emptyLines = this.buildEmptyLines(width);
		const result = [...emptyLines, ...contentLines, ...emptyLines];
		return this.cacheResult(result.length > 0 ? result : [""], width);
	}

	private clampPadding(width: number): number {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		return Math.min(this.paddingX, maxPadding);
	}

	private buildContentLines(
		text: string,
		contentWidth: number,
		width: number,
		paddingX: number,
	): string[] {
		const margin = " ".repeat(paddingX);
		const wrappedLines = wrapTextWithAnsi(text, contentWidth);
		return wrappedLines.map((line) => {
			const lineWithMargins = margin + line + margin;
			if (this.customBgFn) {
				return applyBackgroundToLine(lineWithMargins, width, this.customBgFn);
			}
			const paddingNeeded = Math.max(0, width - visibleWidth(lineWithMargins));
			return lineWithMargins + " ".repeat(paddingNeeded);
		});
	}

	private buildEmptyLines(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return Array.from({ length: this.paddingY }, () => {
			if (this.customBgFn) {
				return applyBackgroundToLine(emptyLine, width, this.customBgFn);
			}
			return emptyLine;
		});
	}

	private cacheResult(lines: string[], width: number): string[] {
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private clearCache(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
