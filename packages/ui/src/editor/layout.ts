import { sliceByColumn, visibleWidth } from "../utils.ts";

const MIN_VISIBLE_LINES = 5;

const VISIBLE_ROWS_RATIO = 0.3;

export interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

export function visibleLineCount(terminalRows: number): number {
	return Math.max(MIN_VISIBLE_LINES, Math.floor(terminalRows * VISIBLE_ROWS_RATIO));
}

export function createScrollBorder(
	direction: "up" | "down",
	hiddenLineCount: number,
	width: number,
): string {
	const availableWidth = Math.max(0, width);
	const label = ` ${direction === "up" ? "above" : "below"} ${hiddenLineCount} more `;
	const labelWidth = visibleWidth(label);
	if (labelWidth + 2 <= availableWidth) {
		const leftWidth = Math.floor((availableWidth - labelWidth) / 2);
		return "─".repeat(leftWidth) + label + "─".repeat(availableWidth - leftWidth - labelWidth);
	}

	const indicator = `─── ${direction} ${hiddenLineCount} more `;
	const remaining = availableWidth - visibleWidth(indicator);
	if (remaining >= 0) return indicator + "─".repeat(remaining);

	const ellipsis = "...".slice(0, availableWidth);
	const indicatorWidth = availableWidth - visibleWidth(ellipsis);
	return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}
