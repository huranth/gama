import { getKeybindings } from "../keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;

const PRIMARY_COLUMN_GAP = 2;

const MIN_DESCRIPTION_WIDTH = 10;

const normalizeToSingleLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

const clamp = (value: number, min: number, max: number): number =>
	Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	currentText?: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private topIndex: number = 0;
	private currentValue: string | undefined;
	private mousePressedIndex: number | undefined;
	private mousePressedRow: number | undefined;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(
		items: SelectItem[],
		maxVisible: number,
		theme: SelectListTheme,
		layout: SelectListLayoutOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) =>
			item.value.toLowerCase().startsWith(filter.toLowerCase()),
		);
		this.selectedIndex = 0;
		this.topIndex = 0;
		this.mousePressedIndex = undefined;
		this.mousePressedRow = undefined;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
		this.revealSelection();
	}

	setCurrentValue(value: string | undefined): void {
		this.currentValue = value;
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}

	invalidate(): void {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.filteredItems.length === 0) return undefined;
		if (event.type === "leave") return undefined;
		if (event.type === "move") return { handled: true };
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			const previousIndex = this.selectedIndex;
			const scrolled = this.scrollViewport(delta);
			this.mousePressedIndex = undefined;
			this.mousePressedRow = undefined;
			if (this.selectedIndex !== previousIndex) this.notifySelectionChange();
			return { handled: true, render: scrolled };
		}

		const isClick = event.type === "press" || event.type === "click";
		if (event.button !== "left" || !isClick) return undefined;

		const { startIndex, endIndex } = this.getVisibleRange();
		const itemIndex = startIndex + event.y;
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;

		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			this.mousePressedRow = event.y;
			if (this.selectedIndex !== itemIndex) {
				this.selectedIndex = itemIndex;
				this.notifySelectionChange();
			}
			return { handled: true, focus: true };
		}

		if (event.type === "click") {
			const sameRowPress =
				this.mousePressedRow === event.y &&
				this.mousePressedIndex !== undefined &&
				this.mousePressedIndex < this.filteredItems.length;
			const clickedIndex = sameRowPress ? this.mousePressedIndex! : itemIndex;
			this.mousePressedIndex = undefined;
			this.mousePressedRow = undefined;
			const changed = this.selectedIndex !== clickedIndex;
			this.selectedIndex = clickedIndex;
			if (changed) this.notifySelectionChange();
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem) this.onSelect?.(selectedItem);
			return { handled: true };
		}

		return undefined;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.clearMousePress();
			this.selectedIndex =
				this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.revealSelection();
			this.notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.clearMousePress();
			this.selectedIndex =
				this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.revealSelection();
			this.notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	get maxTopIndex(): number {
		return Math.max(0, this.filteredItems.length - this.maxVisible);
	}

	private clearMousePress(): void {
		this.mousePressedIndex = undefined;
		this.mousePressedRow = undefined;
	}

	private scrollViewport(delta: number): boolean {
		const visible = Math.min(this.maxVisible, this.filteredItems.length);
		const nextTop = clamp(this.topIndex + delta, 0, this.maxTopIndex);
		const nextIndex = clamp(this.selectedIndex, nextTop, nextTop + visible - 1);
		const scrolled = nextTop !== this.topIndex || nextIndex !== this.selectedIndex;
		this.topIndex = nextTop;
		this.selectedIndex = nextIndex;
		return scrolled;
	}

	private revealSelection(): void {
		const visible = Math.min(this.maxVisible, this.filteredItems.length);
		const belowView = this.selectedIndex >= this.topIndex + visible;
		if (this.selectedIndex < this.topIndex) {
			this.topIndex = this.selectedIndex;
		} else if (belowView) {
			this.topIndex = this.selectedIndex - visible + 1;
		}
		this.topIndex = Math.max(0, Math.min(this.topIndex, this.maxTopIndex));
	}

	private getVisibleRange(): { startIndex: number; endIndex: number } {
		this.topIndex = Math.max(0, Math.min(this.topIndex, this.maxTopIndex));
		const startIndex = this.topIndex;
		return {
			startIndex,
			endIndex: Math.min(startIndex + this.maxVisible, this.filteredItems.length),
		};
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = "  ";
		const prefixWidth = visibleWidth(prefix);

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(
				1,
				Math.min(primaryColumnWidth, width - prefixWidth - 4),
			);
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(
				item,
				isSelected,
				maxPrimaryWidth,
				effectivePrimaryColumnWidth,
			);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2;

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "");
				const fullLine = `${prefix}${truncatedValue}${spacing}${truncatedDesc}`;
				if (isSelected) return this.theme.selectedText(fullLine);
				const descText = this.theme.description(spacing + truncatedDesc);
				return this.styleCurrent(item, prefix + truncatedValue) + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		const fullLine = `${prefix}${truncatedValue}`;
		if (isSelected) {
			return this.theme.selectedText(fullLine);
		}
		return this.styleCurrent(item, fullLine);
	}

	private styleCurrent(item: SelectItem, line: string): string {
		if (this.currentValue === undefined || item.value !== this.currentValue) {
			return line;
		}
		return this.theme.currentText ? this.theme.currentText(line) : line;
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);
		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ??
			this.layout.maxPrimaryColumnWidth ??
			DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ??
			this.layout.minPrimaryColumnWidth ??
			DEFAULT_PRIMARY_COLUMN_WIDTH;
		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(
		item: SelectItem,
		isSelected: boolean,
		maxWidth: number,
		columnWidth: number,
	): string {
		const displayValue = this.getDisplayValue(item);
		const customTruncate = this.layout.truncatePrimary;
		const truncatedValue = customTruncate
			? customTruncate({ text: displayValue, maxWidth, columnWidth, item, isSelected })
			: truncateToWidth(displayValue, maxWidth, "");
		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return item.label || item.value;
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch("  No matching commands"));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();
		const { startIndex, endIndex } = this.getVisibleRange();

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const singleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, singleLine, primaryColumnWidth));
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredItems.length})`;
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}
}
