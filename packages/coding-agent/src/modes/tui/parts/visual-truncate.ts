import { type Component, Text, truncateToWidth } from "@huranth/gama-tui";

export interface VisualTruncateResult {
	visualLines: string[];
	skippedCount: number;
}

export interface VisualLinePreviewOptions {
	text: string;
	maxVisualLines: number;
	keep: "start" | "end";
	formatHint: (hidden: number) => string;
}

export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
	keep: "start" | "end" = "end",
): VisualTruncateResult {
	if (!text) return { visualLines: [], skippedCount: 0 };

	const tempText = new Text(text, paddingX, 0);
	const allVisualLines = tempText.render(width);
	if (maxVisualLines <= 0) {
		return { visualLines: [], skippedCount: allVisualLines.length };
	}
	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	const visualLines =
		keep === "start"
			? allVisualLines.slice(0, maxVisualLines)
			: allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines, skippedCount };
}

export class VisualLinePreview implements Component {
	private options: VisualLinePreviewOptions;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: VisualLinePreviewOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines = this.buildLines(width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private buildLines(width: number): string[] {
		const { text, maxVisualLines, keep, formatHint } = this.options;
		const preview = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
		const lines = preview.visualLines;
		if (preview.skippedCount === 0) return lines;

		const hint = formatHint(preview.skippedCount);
		const hintLine = truncateToWidth(hint, width, "...");

		return keep === "start" ? [...lines, hintLine] : [hintLine, ...lines];
	}
}
