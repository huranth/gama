import { getKeybindings } from "../keybindings.ts";
import { matchesKey } from "../keys.ts";
import {
	getLayoutBoxesAt,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutFrame,
	type LayoutRect,
} from "../layout.ts";
import type { ScrollView } from "../view/scroll-view.ts";
import { isImageLine } from "../terminal-image.ts";
import { type Component, resolveTextSelectionTarget } from "../screen.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "../utils.ts";
import type { SgrMouseEvent } from "./mouse.ts";

export interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
	boundary?: boolean;
}

export interface SelectionRange {
	start: SelectionPoint;
	end: SelectionPoint;
}

export type SelectionGranularity = "character" | "word" | "line";

export interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	scrollView?: ScrollView;
	wordStart: number;
	wordEnd: number;
}

export interface SelectionHost {
	getLayout(): LayoutFrame | undefined;
	getScreenLines(): readonly string[];
	getRows(): number;
	getColumns(): number;
	hasOverlay(): boolean;
	isOverlayRow(row: number): boolean;
	requestRender(): void;
	dispatchClick(button: number, x: number, y: number, clickCount: number): void;
	copySelection(): void;
	openUrl?(url: string): void;
}

interface TextSelectionHost {
	getTextSelectionLeft?(): number;
	getTextSelectionEnd?(row: number): number | undefined;
}

const doubleClickIntervalMs = 500;

const autoScrollIntervalMs = 24;

const autoScrollStartLines = 2;

const autoScrollRampMs = 120;

const autoScrollMaxLines = 16;

const wordSelectionJoiners = new Set(["/", "-"]);

const wordSegmenter = getWordSegmenter();

export class TextSelection {
	anchor: SelectionPoint | undefined;
	focus: SelectionPoint | undefined;
	clip: LayoutRect | undefined;
	target: { component: Component; rect: LayoutRect } | undefined;
	left = 0;
	granularity: SelectionGranularity = "character";
	initialRange: SelectionRange | undefined;
	lastClick: ClickTarget | undefined;
	pressedUrl: string | undefined;
	dragged = false;
	pressActive = false;
	dragPointer: { x: number; y: number } | undefined;
	autoScrollDirection: -1 | 0 | 1 = 0;
	autoScrollStartedAt: number | undefined;
	autoScrollTimer: NodeJS.Timeout | undefined;
	private readonly host: SelectionHost;

	constructor(host: SelectionHost) {
		this.host = host;
	}

	hasSelection(): boolean {
		return this.getBounds() !== undefined;
	}

	clear(): void {
		this.resetGesture();
		this.anchor = undefined;
		this.focus = undefined;
		this.clip = undefined;
		this.target = undefined;
		this.left = 0;
		this.granularity = "character";
		this.initialRange = undefined;
	}

	resetGesture(): void {
		this.stopAutoScroll();
		this.pressActive = false;
		this.pressedUrl = undefined;
		this.dragged = false;
	}

	getBounds(): SelectionRange | undefined {
		if (!this.anchor || !this.focus) return undefined;
		if (this.anchor.scrollView !== this.focus.scrollView) return undefined;
		if (this.anchor.row === this.focus.row && this.anchor.col === this.focus.col) {
			return undefined;
		}
		const anchorBeforeFocus =
			this.anchor.row < this.focus.row ||
			(this.anchor.row === this.focus.row && this.anchor.col < this.focus.col);
		return anchorBeforeFocus
			? { start: this.anchor, end: this.focus }
			: { start: this.focus, end: this.anchor };
	}

	isBorderOrBlankLine(line: string): boolean {
		return /^[\s\u2500-\u257F]*$/.test(line);
	}

	getLineContentBounds(line: string): { start: number; end: number } | undefined {
		const plain = stripTerminalSequences(line);
		if (this.isBorderOrBlankLine(plain)) return undefined;
		const leading = plain.match(/^[\s\u2500-\u257F]+/)?.[0].length ?? 0;
		const content = plain.slice(leading).replace(/[\s\u2500-\u257F]+$/, "");
		if (content === "") return undefined;
		return { start: leading, end: leading + visibleWidth(content) };
	}

	getLineBorderlessBounds(line: string): { start: number; end: number } | undefined {
		const plain = stripTerminalSequences(line);
		if (/^[\s\u2500-\u257F]*$/.test(plain)) return undefined;
		const leading = plain.match(/^\s*[\u2500-\u257F]+\s*/)?.[0].length ?? 0;
		const trailing = plain.match(/\s*[\u2500-\u257F]+\s*$/)?.[0].length ?? 0;
		const start = leading;
		const end = visibleWidth(plain) - trailing;
		return end > start ? { start, end } : undefined;
	}

	getLineSelectionStart(line: string): number {
		return stripTerminalSequences(line).match(/^[ \t]+/)?.[0].length ?? 0;
	}

	getLineVisibleEnd(line: string): number {
		return visibleWidth(stripTerminalSequences(line).trimEnd());
	}

	getColumns(
		line: string,
		row: number,
		selection: SelectionRange,
		minColumn = 0,
		maxColumn = visibleWidth(line),
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start =
				getGraphemeCellRange(line, selection.start.col)?.start ??
				Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = selection.end.boundary
				? Math.min(selection.end.col, lineWidth)
				: (getGraphemeCellRange(line, selection.end.col)?.end ??
					Math.min(selection.end.col + 1, lineWidth));
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	hasTextSelectionOffset(): boolean {
		const textHost = this.target?.component as (Component & TextSelectionHost) | undefined;
		return typeof textHost?.getTextSelectionLeft === "function";
	}

	getTextSelectionHostEnd(row: number): number | undefined {
		const target = this.target;
		if (!target) return undefined;
		const hit = resolveTextSelectionTarget(
			target.component,
			this.left - target.rect.x,
			row - target.rect.y,
			target.rect.width,
		);
		if (!hit) return undefined;
		const textHost = hit.target as TextSelectionHost;
		if (typeof textHost.getTextSelectionEnd !== "function") return undefined;
		const end = textHost.getTextSelectionEnd(hit.row);
		return end === undefined ? undefined : this.left + end;
	}

	getSourceLine(point: SelectionPoint): string {
		if (point.scrollView) {
			const layout = this.host.getLayout();
			const lines = layout
				? getScrollViewBox(layout, point.scrollView)?.scrollContentLines
				: undefined;
			if (lines) return lines[point.row] ?? "";
		}
		return this.host.getScreenLines()[point.row] ?? "";
	}

	getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSourceLine(point));
		const segments: Array<{
			start: number;
			end: number;
			selectable: boolean;
			joiner: boolean;
		}> = [];
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			const joiner = wordSelectionJoiners.has(segment.segment);
			segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
			start = end;
		}
		const clickedSegmentIndex = segments.findIndex(
			(segment) => point.col >= segment.start && point.col < segment.end,
		);
		if (clickedSegmentIndex < 0) return undefined;

		const canJoin = (
			left: { selectable: boolean; joiner: boolean },
			right: { selectable: boolean; joiner: boolean },
		): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
		let selectionStart = segments[clickedSegmentIndex].start;
		let selectionEnd = segments[clickedSegmentIndex].end;
		for (
			let index = clickedSegmentIndex;
			index > 0 && canJoin(segments[index - 1], segments[index]);
			index--
		) {
			selectionStart = segments[index - 1].start;
		}
		for (
			let index = clickedSegmentIndex;
			index < segments.length - 1 && canJoin(segments[index], segments[index + 1]);
			index++
		) {
			selectionEnd = segments[index + 1].end;
		}
		return {
			start: { ...point, col: selectionStart },
			end: { ...point, col: selectionEnd, boundary: true },
		};
	}

	getLineSelection(point: SelectionPoint): SelectionRange {
		return {
			start: { ...point, col: 0 },
			end: { ...point, col: visibleWidth(this.getSourceLine(point)), boundary: true },
		};
	}

	updateFocus(point: SelectionPoint): void {
		if (this.granularity === "character" || !this.initialRange) {
			this.focus = point;
			return;
		}
		const range =
			this.granularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.initialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.anchor = initial.end;
			this.focus = range.start;
		} else {
			this.anchor = initial.start;
			this.focus = range.end;
		}
	}

	getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= doubleClickIntervalMs &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	getScrollPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		const layout = this.host.getLayout();
		if (!layout) return undefined;
		const box = getScrollViewBox(layout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.host.getRows() - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	getPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		const clip = this.clip;
		const rows = this.host.getRows();
		const columns = this.host.getColumns();
		const minRow = clip ? Math.max(0, clip.y) : 0;
		const maxRow = clip ? Math.min(rows - 1, clip.y + clip.height - 1) : rows - 1;
		const minColumn = clip ? Math.max(0, clip.x) : 0;
		const maxColumn = clip ? Math.min(columns - 1, clip.x + clip.width - 1) : columns - 1;
		return {
			row: Math.max(minRow, Math.min(maxRow, event.y)),
			col: Math.max(minColumn, Math.min(maxColumn, event.x)),
		};
	}

	updateAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.anchor?.scrollView;
		const layout = this.host.getLayout();
		if (!scrollView || !layout) {
			this.stopAutoScroll();
			return;
		}
		const box = getScrollViewBox(layout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.host.getRows() - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.dragPointer = { x: event.x, y: event.y };
		const direction = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (direction === 0) {
			this.stopAutoScroll();
			return;
		}
		if (direction !== this.autoScrollDirection) {
			this.autoScrollDirection = direction;
			this.autoScrollStartedAt = performance.now();
		}
		if (this.autoScrollTimer) return;
		this.autoScrollStartedAt = performance.now();
		this.autoScrollTimer = setInterval(() => this.autoScroll(), autoScrollIntervalMs);
		this.autoScrollTimer.unref();
	}

	autoScroll(): void {
		const scrollView = this.anchor?.scrollView;
		const pointer = this.dragPointer;
		const direction = this.autoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopAutoScroll();
			return;
		}
		const heldMs =
			this.autoScrollStartedAt === undefined ? 0 : performance.now() - this.autoScrollStartedAt;
		const lines = Math.min(
			autoScrollMaxLines,
			autoScrollStartLines + Math.floor(heldMs / autoScrollRampMs),
		);
		const requested = direction * lines;
		const remaining = scrollView.scrollBy(requested);
		if (remaining === requested) {
			this.stopAutoScroll();
			return;
		}
		const point = this.getScrollPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateFocus(point);
		this.host.requestRender();
	}

	stopAutoScroll(): void {
		if (this.autoScrollTimer) {
			clearInterval(this.autoScrollTimer);
			this.autoScrollTimer = undefined;
		}
		this.autoScrollDirection = 0;
		this.autoScrollStartedAt = undefined;
		this.dragPointer = undefined;
	}

	getActiveText(): string | undefined {
		const selection = this.getBounds();
		if (!selection) return undefined;
		let sourceLines: readonly string[] = this.host.getScreenLines();
		if (selection.start.scrollView) {
			const layout = this.host.getLayout();
			if (!layout) return undefined;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box?.scrollContentLines) return undefined;
			sourceLines = box.scrollContentLines;
		}
		const usesScreenCoordinates = selection.start.scrollView === undefined;
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? "";
			if (isImageLine(line)) continue;
			const plainLine = stripTerminalSequences(line);
			if (this.isBorderOrBlankLine(plainLine) && /[\u2500-\u257F]/.test(plainLine)) {
				continue;
			}
			let minColumn = 0;
			let maxColumn = visibleWidth(line);
			if (usesScreenCoordinates) {
				if (this.hasTextSelectionOffset()) {
					minColumn = Math.max(minColumn, this.left);
				} else {
					const content = this.getLineContentBounds(line);
					if (content) minColumn = Math.max(minColumn, content.start);
				}
			} else {
				minColumn = Math.max(minColumn, this.getLineSelectionStart(line));
				const borderless = this.getLineBorderlessBounds(line);
				if (borderless) {
					minColumn = Math.max(minColumn, borderless.start);
					maxColumn = Math.min(maxColumn, borderless.end);
				}
			}
			const hostEnd = usesScreenCoordinates ? this.getTextSelectionHostEnd(row) : undefined;
			if (hostEnd !== undefined) {
				maxColumn = Math.min(maxColumn, hostEnd);
			} else if (row !== selection.end.row || selection.end.boundary) {
				maxColumn = Math.min(maxColumn, this.getLineVisibleEnd(line));
			}
			const columns = this.getColumns(line, row, selection, minColumn, maxColumn);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				),
			);
		}
		const text = lines.join("\n");
		return text.length === 0 ? undefined : text;
	}

	handleDeleteKey(data: string): boolean {
		const keybindings = getKeybindings();
		if (
			!keybindings.matches(data, "tui.editor.deleteCharBackward") &&
			data !== "\x08" &&
			data !== "\x7f" &&
			!matchesKey(data, "shift+backspace")
		) {
			return false;
		}
		const selection = this.getBounds();
		if (!selection) return false;
		const target = this.target;
		if (!target || selection.start.scrollView) {
			this.clearAndRender();
			return true;
		}
		const resolveHit = (point: SelectionPoint) =>
			resolveTextSelectionTarget(
				target.component,
				point.col - target.rect.x,
				point.row - target.rect.y,
				target.rect.width,
			);
		const startHit = resolveHit(selection.start);
		const endHit = resolveHit(selection.end);
		if (!startHit || !endHit || startHit.target !== endHit.target) {
			this.clearAndRender();
			return true;
		}
		const localSelection = {
			start: { row: startHit.row, col: startHit.col },
			end: { row: endHit.row, col: endHit.col },
		};
		const startLine = startHit.lines[startHit.row];
		const endLine = endHit.lines[endHit.row];
		if (startLine === undefined || endLine === undefined) {
			this.clearAndRender();
			return true;
		}
		const startColumns = this.getColumns(startLine, localSelection.start.row, localSelection);
		const endColumns = this.getColumns(endLine, localSelection.end.row, localSelection);
		const deleted = startHit.target.deleteScreenSelection(
			{ row: localSelection.start.row, col: startColumns.start },
			{ row: localSelection.end.row, col: endColumns.end },
		);
		if (!deleted) return false;
		this.clearAndRender();
		return true;
	}

	applyHighlight(text: string): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			result += ansi.code;
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	apply(screen: string[], layout: LayoutFrame | undefined): string[] {
		const selection = this.getBounds();
		if (!selection) return screen;
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.host.getColumns();
		if (!selection.start.scrollView && this.clip) {
			const clip = this.clip;
			minRow = Math.max(minRow, clip.y);
			maxRow = Math.min(maxRow, clip.y + clip.height - 1);
			minColumn = Math.max(minColumn, clip.x);
			maxColumn = Math.min(maxColumn, clip.x + clip.width);
		}
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(
				screen.length - 1,
				box.rect.y + box.rect.height - 1,
				box.clip.y + box.clip.height - 1,
			);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(
				this.host.getColumns(),
				box.rect.x + box.rect.width,
				box.clip.x + box.clip.width,
			);
			screenSelection = {
				start: {
					...selection.start,
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line) ||
				(selection.start.scrollView !== undefined && this.host.isOverlayRow(row))
			) {
				return line;
			}
			const lineWidth = visibleWidth(line);
			const plainLine = stripTerminalSequences(line);
			if (this.isBorderOrBlankLine(plainLine) && /[\u2500-\u257F]/.test(plainLine)) {
				return line;
			}
			const columns = this.getColumns(line, row, screenSelection, minColumn, maxColumn);
			if (selection.start.scrollView) {
				if (this.isBorderOrBlankLine(plainLine)) return line;
				// Skip decorations
				columns.start = Math.max(columns.start, this.getLineSelectionStart(line));
				const borderless = this.getLineBorderlessBounds(line);
				if (borderless) columns.start = Math.max(columns.start, borderless.start);
				if (row !== screenSelection.end.row || screenSelection.end.boundary) {
					columns.end = Math.min(columns.end, this.getLineVisibleEnd(line));
				}
				if (borderless) columns.end = Math.min(columns.end, borderless.end);
			} else if (this.hasTextSelectionOffset()) {
				columns.start = Math.max(columns.start, this.left);
				const hostEnd = this.getTextSelectionHostEnd(row);
				if (hostEnd !== undefined) columns.end = Math.min(columns.end, hostEnd);
			} else {
				const content = this.getLineContentBounds(line);
				if (!content) return line;
				columns.start = Math.max(columns.start, content.start);
				columns.end = Math.min(columns.end, content.end);
			}
			if (columns.end <= columns.start) return line;
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}${this.applyHighlight(selected)}${after}`;
		});
	}

	handleMouseEvent(event: SgrMouseEvent): void {
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		const anchorScrollView = this.anchor?.scrollView;
		const point = this.getPoint(event, anchorScrollView);
		if (event.release) {
			this.release(event, point);
			return;
		}
		if ((event.button & 32) !== 0) {
			this.drag(event, point);
			return;
		}
		this.press(event);
	}

	private release(event: SgrMouseEvent, point: SelectionPoint): void {
		if (!this.pressActive) return;
		this.pressActive = false;
		this.stopAutoScroll();
		if (!this.anchor) return;
		this.updateFocus(point);
		const isClick = this.isClickRelease(point);
		const clickedUrl = isClick ? this.pressedUrl : undefined;
		this.pressedUrl = undefined;
		if (clickedUrl && this.host.openUrl) {
			this.anchor = undefined;
			this.focus = undefined;
			this.host.openUrl(clickedUrl);
			this.host.requestRender();
			return;
		}
		if (isClick) {
			this.host.dispatchClick(event.button, event.x, event.y, this.lastClick?.count ?? 1);
			this.clear();
			this.host.requestRender();
			return;
		}
		this.host.copySelection();
		this.host.requestRender();
	}

	private isClickRelease(point: SelectionPoint): boolean {
		if (this.granularity !== "character") return false;
		if (this.anchor?.scrollView !== point.scrollView) return false;
		if (!this.dragged) return true;
		return this.isSingleCellSelection();
	}

	private isSingleCellSelection(): boolean {
		const bounds = this.getBounds();
		if (!bounds || bounds.start.row !== bounds.end.row) return false;
		if (bounds.end.col - bounds.start.col > 1) return false;
		const line = this.getSourceLine(bounds.start);
		return this.isSimpleCell(line, bounds.start.col) && this.isSimpleCell(line, bounds.end.col);
	}

	private isSimpleCell(line: string, col: number): boolean {
		const range = getGraphemeCellRange(line, col);
		if (!range) return true;
		if (range.end - range.start > 1) return false;
		const text = stripTerminalSequences(
			sliceByColumn(line, range.start, range.end - range.start, true),
		);
		return [...text].length <= 1;
	}

	private drag(event: SgrMouseEvent, point: SelectionPoint): void {
		if (!this.pressActive || !this.anchor) return;
		const anchor = this.anchor;
		const movedEnough = point.row !== anchor.row || point.col !== anchor.col;
		if (!movedEnough) {
			this.updateAutoScroll(event);
			return;
		}
		this.dragged = true;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.updateFocus(point);
		this.updateAutoScroll(event);
		this.host.requestRender();
	}

	private press(event: SgrMouseEvent): void {
		this.stopAutoScroll();
		this.pressActive = true;
		const layout = this.host.getLayout();
		const scrollView =
			!this.host.hasOverlay() && layout
				? getScrollViewsAt(layout, event.x, event.y)[0]
				: undefined;
		const targetBox =
			!scrollView && !this.host.hasOverlay() && layout
				? getLayoutBoxesAt(layout, event.x, event.y)[0]
				: undefined;
		this.clip = scrollView ? undefined : targetBox?.clip;
		this.target = targetBox
			? { component: targetBox.component, rect: { ...targetBox.rect } }
			: undefined;
		this.left = 0;
		if (!scrollView && layout) {
			for (const box of getLayoutBoxesAt(layout, event.x, event.y)) {
				const textHost = box.component as Component & TextSelectionHost;
				const offset = textHost.getTextSelectionLeft?.();
				if (typeof offset === "number") {
					this.left = Math.max(this.left, box.rect.x + offset);
				}
			}
		}
		const anchor = this.getPoint(event, scrollView);
		const word = this.getWordSelection(anchor);
		const clickCount = this.getClickCount(anchor, word);
		const lineRange = clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		const range = clickCount === 2 ? word : lineRange;
		let granularity: SelectionGranularity = "character";
		if (clickCount === 2) granularity = "word";
		if (clickCount === 3) granularity = "line";
		this.granularity = granularity;
		this.initialRange = range;
		this.anchor = range?.start ?? anchor;
		this.focus = range?.end ?? anchor;
		this.dragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.host.getScreenLines()[
						Math.max(0, Math.min(this.host.getRows() - 1, event.y))
					] ?? "",
					Math.max(0, Math.min(this.host.getColumns() - 1, event.x)),
				);
		this.host.requestRender();
	}

	private clearAndRender(): void {
		this.clear();
		this.host.requestRender();
	}
}
