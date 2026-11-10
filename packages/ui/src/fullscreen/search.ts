import {
	type AltScreenSearchComponent,
	type AltScreenSearchIndex,
	type AltScreenSearchMatch,
	getAltScreenSearchMatchKey,
} from "../alt-screen-search.ts";
import { getScrollbarGeometry, type LayoutBox } from "../layout.ts";
import type { OverlayHandle } from "../screen.ts";
import { extractAnsiCode } from "../utils.ts";
import type { ScrollView } from "../view/scroll-view.ts";

export type SearchSelectionMode = "query" | "retain" | "next" | "previous";

export interface ActiveSearch {
	component: AltScreenSearchComponent;
	index: AltScreenSearchIndex;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey?: string;
	anchorRow: number;
	selectionMode: SearchSelectionMode;
}

export interface SearchHighlightRange {
	startCol: number;
	endCol: number;
	current: boolean;
}

export function applySearchTextHighlight(text: string, style: (text: string) => string): string {
	let result = "";
	let plainStart = 0;
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (!ansi) {
			index += 1;
			continue;
		}
		if (index > plainStart) result += style(text.slice(plainStart, index));
		result += ansi.code;
		index += ansi.length;
		plainStart = index;
	}
	if (plainStart < text.length) result += style(text.slice(plainStart));
	return result;
}

export function pickSearchSelection(
	matches: AltScreenSearchMatch[],
	mode: SearchSelectionMode,
	anchorRow: number,
	previousIndex: number,
	previousKey: string | undefined,
	changed: boolean,
): number {
	if (matches.length === 0) return -1;
	const exactIndex = changed
		? previousKey
			? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === previousKey)
			: -1
		: previousIndex;
	if (mode === "query") {
		let low = 0;
		let high = matches.length;
		while (low < high) {
			const middle = low + Math.floor((high - low) / 2);
			if ((matches[middle]!.segments[0]?.row ?? 0) < anchorRow) low = middle + 1;
			else high = middle;
		}
		return low < matches.length ? low : 0;
	}
	if (mode === "next") {
		const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(previousIndex, matches.length - 1);
		return baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
	}
	if (mode === "previous") {
		const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(previousIndex, matches.length - 1);
		if (baseIndex < 0) return matches.length - 1;
		return (baseIndex - 1 + matches.length) % matches.length;
	}
	if (exactIndex >= 0) return exactIndex;
	return Math.min(Math.max(0, previousIndex), matches.length - 1);
}

export function getSearchHighlightRanges(
	screenLength: number,
	terminalColumns: number,
	box: LayoutBox,
	scrollView: ScrollView,
	matches: AltScreenSearchMatch[],
	selectedIndex: number,
): Map<number, SearchHighlightRange[]> {
	const rangesByRow = new Map<number, SearchHighlightRange[]>();
	const scrollbarColumn = getScrollbarGeometry(box)?.column;
	const minRow = Math.max(0, box.rect.y, box.clip.y);
	const maxRow = Math.min(
		screenLength,
		box.rect.y + box.rect.height,
		box.clip.y + box.clip.height,
	);
	const minColumn = Math.max(0, box.rect.x, box.clip.x);
	const maxColumn = Math.min(
		terminalColumns,
		box.rect.x + box.rect.width,
		box.clip.x + box.clip.width,
		scrollbarColumn ?? Number.POSITIVE_INFINITY,
	);
	const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
	const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
	let low = 0;
	let high = matches.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		const match = matches[middle]!;
		const lastRow = match.segments[match.segments.length - 1]?.row ?? -1;
		if (lastRow < minContentRow) low = middle + 1;
		else high = middle;
	}
	for (let matchIndex = low; matchIndex < matches.length; matchIndex++) {
		const match = matches[matchIndex]!;
		if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
		for (const segment of match.segments) {
			const row = box.rect.y + segment.row - scrollView.scrollTop;
			if (row < minRow || row >= maxRow) continue;
			const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
			const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
			if (endCol <= startCol) continue;
			const ranges = rangesByRow.get(row) ?? [];
			ranges.push({ startCol, endCol, current: matchIndex === selectedIndex });
			rangesByRow.set(row, ranges);
		}
	}
	return rangesByRow;
}
