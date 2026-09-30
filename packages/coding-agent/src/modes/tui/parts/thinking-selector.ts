import type { ThinkingLevel } from "@huranth/gama-agent-core";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@huranth/gama-tui";
import { reasoningLevelName } from "../../../core/defaults.ts";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

export class ThinkingSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private selectListChildIndex: number;
	private allItems: SelectItem[];
	private onSelect: (level: ThinkingLevel) => void;
	private onCancel: () => void;
	private onSelectAsDefault?: (level: ThinkingLevel) => void;
	private currentLevel: ThinkingLevel;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
		defaultThinkingLevel?: ThinkingLevel,
	) {
		super();
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.onSelectAsDefault = onSelectAsDefault;
		this.currentLevel = currentLevel;

		this.allItems = availableLevels.map((level) => ({
			value: level,
			label: reasoningLevelName(level),
			description:
				level === defaultThinkingLevel
					? `${LEVEL_DESCRIPTIONS[level]} · default`
					: LEVEL_DESCRIPTIONS[level],
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("Reasoning Level", 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.selectList = this.buildSelectList(this.allItems, currentLevel);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private buildSelectList(items: SelectItem[], preselect: ThinkingLevel | undefined): SelectList {
		const list = new SelectList(
			items,
			Math.max(1, items.length),
			getSelectListTheme(),
			THINKING_SELECT_LIST_LAYOUT,
		);
		const currentIndex = items.findIndex((item) => item.value === preselect);
		if (currentIndex !== -1) {
			list.setSelectedIndex(currentIndex);
		}

		// Keep current
		list.setCurrentValue(this.currentLevel);
		list.onSelect = (item) => this.onSelect(item.value as ThinkingLevel);
		list.onCancel = () => this.onCancel();

		return list;
	}

	private searchText(item: SelectItem): string {
		const name = reasoningLevelName(item.value);
		const description = item.description ?? "";
		return `${name} ${item.value} ${description}`;
	}

	private applyFilter(query: string): void {
		const filtered = query ? this.filterItems(query) : this.allItems;
		const selected = this.selectList.getSelectedItem()?.value as ThinkingLevel | undefined;
		const nextList = this.buildSelectList(filtered, selected);

		this.children[this.selectListChildIndex] = nextList;
		this.selectList = nextList;
	}

	private filterItems(query: string): SelectItem[] {
		return fuzzyFilter(this.allItems, query, (item) => this.searchText(item));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "app.thinking.save") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value as ThinkingLevel);

			return;
		}

		const isNav =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (isNav) {
			this.selectList.handleInput(keyData);

			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
