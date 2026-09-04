import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
	submenu?: (
		currentValue: string,
		done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
	) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	selectedRow?: (text: string) => string;
	description: (text: string) => string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
}

export class SettingsList implements Component {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private mousePressedIndex: number | undefined;
	private mousePressedRow: number | undefined;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;
	private navigateAfterClose: string | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	selectItem(id: string): void {
		const items = this.searchEnabled ? this.filteredItems : this.items;
		const index = items.findIndex((i) => i.id === id);
		if (index !== -1) {
			this.selectedIndex = index;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.submenuComponent) {
			const result = this.submenuComponent.handleMouse?.(event);
			return result ? { ...result, focus: true } : undefined;
		}

		if (this.searchEnabled && this.searchInput && event.type !== "wheel") {
			if (event.y === 0) {
				const result = this.searchInput.handleMouse?.(event);
				return result ? { ...result, focus: true } : undefined;
			}
			if (event.y === 1) return undefined;
		}

		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) return undefined;
		if (event.type === "leave") return undefined;
		// Hover inert
		if (event.type === "move") return { handled: true };
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			const previousIndex = this.selectedIndex;
			this.selectedIndex = Math.max(
				0,
				Math.min(displayItems.length - 1, this.selectedIndex + delta),
			);
			// Reset press
			this.mousePressedIndex = undefined;
			this.mousePressedRow = undefined;
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}

		const isPress = event.type === "press" || event.type === "click";
		if (event.button !== "left" || !isPress) {
			return undefined;
		}

		const rowOffset = this.searchEnabled ? 2 : 0;
		const { startIndex, endIndex } = this.getVisibleRange(displayItems);
		const itemIndex = startIndex + event.y - rowOffset;
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;

		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			this.mousePressedRow = event.y;
			this.selectedIndex = itemIndex;
			return { handled: true, focus: true };
		}

		if (event.type === "click") {
			// Same-row
			const sameRowPress =
				this.mousePressedRow === event.y &&
				this.mousePressedIndex !== undefined &&
				this.mousePressedIndex < displayItems.length;
			this.selectedIndex = sameRowPress ? this.mousePressedIndex! : itemIndex;
			this.mousePressedIndex = undefined;
			this.mousePressedRow = undefined;
			this.activateItem();
			return { handled: true };
		}

		return undefined;
	}

	handleInput(data: string): void {
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		const kb = getKeybindings();
		const displayItems = this.getDisplayItems();
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) {
				return;
			}

			this.clearMousePress();
			this.selectedIndex =
				this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) {
				return;
			}

			this.clearMousePress();
			this.selectedIndex =
				this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (
			kb.matches(data, "tui.select.confirm") ||
			(data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0))
		) {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private clearMousePress(): void {
		this.mousePressedIndex = undefined;
		this.mousePressedRow = undefined;
	}

	private getDisplayItems(): SettingItem[] {
		return this.searchEnabled ? this.filteredItems : this.items;
	}

	private getVisibleRange(displayItems: readonly SettingItem[]): {
		startIndex: number;
		endIndex: number;
	} {
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				displayItems.length - this.maxVisible,
			),
		);
		return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, displayItems.length) };
	}

	private activateItem(): void {
		const item = this.getDisplayItems()[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(
				item.currentValue,
				(selectedValue?: string, options?: { navigateTo?: string }) => {
					if (selectedValue !== undefined) {
						item.currentValue = selectedValue;
						this.onChange(item.id, selectedValue);
					}
					if (options?.navigateTo) {
						this.navigateAfterClose = options.navigateTo;
					}
					this.closeSubmenu();
				},
			);
		} else if (item.values && item.values.length > 0) {
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		if (this.navigateAfterClose !== null) {
			const id = this.navigateAfterClose;
			this.navigateAfterClose = null;
			this.submenuItemIndex = null;
			this.selectItem(id);
			// Recheck target
			if (this.getDisplayItems()[this.selectedIndex]?.id === id) {
				this.activateItem();
			}
		} else if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
		this.clearMousePress();
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search, Enter/Space to change, Esc to cancel"
						: "  Enter/Space to change, Esc to cancel",
				),
				width,
			),
		);
	}

	render(width: number): string[] {
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		const { startIndex, endIndex } = this.getVisibleRange(displayItems);

		const maxLabelWidth = Math.min(
			36,
			Math.max(...this.items.map((item) => visibleWidth(item.label))),
		);

		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			// Color only
			const labelPadded =
				item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const styledAsCursor = isSelected;

			const labelText = this.theme.label(labelPadded, styledAsCursor);
			const separator = "  ";
			const usedWidth = maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(
				truncateToWidth(item.currentValue, valueMaxWidth, ""),
				styledAsCursor,
			);

			const rowText = labelText + separator + valueText;
			const rowStyled = isSelected ? (this.theme.selectedRow?.(rowText) ?? rowText) : rowText;
			lines.push(truncateToWidth(rowStyled, width));
		}

		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, Math.max(1, width - 4));
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		this.addHintLine(lines, width);

		return lines;
	}
}
