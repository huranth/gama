import { type Model, modelsAreEqual } from "@huranth/gama-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@huranth/gama-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

type ModelScope = "all" | "scoped";

const MAX_VISIBLE = 10;

export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private topIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private readonly refreshAbortController = new AbortController();
	private readonly providerFilter?: string;
	private readonly onConnectProvider?: () => void;
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
		providerFilter?: string,
		onConnectProvider?: () => void,
		skipInitialRefresh = false,
	) {
		super();

		this.tui = tui;
		this.providerFilter = providerFilter;
		this.onConnectProvider = onConnectProvider;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.loadModelsFromSnapshot();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
		if (!this.providerFilter && !skipInitialRefresh) void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime
			.getAvailableSnapshot()
			.filter((model) => !this.providerFilter || model.provider === this.providerFilter)
			.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) =>
			modelsAreEqual(this.currentModel, item.model),
		);
		this.selectedIndex =
			currentIndex >= 0
				? currentIndex
				: Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.revealSelection();
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const selected = this.filteredModels[this.selectedIndex];
			await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.errorMessage = this.modelRuntime.getError();
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			const restoredIndex = selected
				? this.filteredModels.findIndex(
						(item) => item.provider === selected.provider && item.id === selected.id,
					)
				: -1;
			if (restoredIndex >= 0) {
				this.selectedIndex = restoredIndex;
				this.revealSelection();
				this.updateList();
			}
			this.tui.requestRender();
		} catch (_error) {
			if (this.closed) return;
			this.errorMessage = timedOut ? "Refresh timed out" : "Refresh failed";
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const currentProvider = this.currentModel?.provider;
		const defaultProvider = this.defaultModel?.provider;
		const providerRank = (provider: string): number => {
			if (currentProvider !== undefined && provider === currentProvider) return 0;
			if (defaultProvider !== undefined && provider === defaultProvider) return 1;
			return 2;
		};

		const sorted = [...models];
		sorted.sort((a, b) => {
			const rankDiff = providerRank(a.provider) - providerRank(b.provider);
			if (rankDiff !== 0) return rankDiff;

			const providerDiff = a.provider.localeCompare(b.provider);
			if (providerDiff !== 0) return providerDiff;

			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			return a.id.localeCompare(b.id);
		});
		return sorted;
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) =>
			modelsAreEqual(this.currentModel, item.model),
		);
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.topIndex = 0;
		this.filterModels(this.searchInput.getValue());
	}

	private filterModels(query: string): void {
		if (query) {
			const filtered = fuzzyFilter(this.activeModels, query, (item) => {
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				const target = { id: item.id, provider: item.provider, name: item.model.name };
				return `${getModelSelectorSearchText(target)}${defaultText}`;
			});
			if (this.isDefaultSearch(query)) {
				const defaultItems = this.activeModels.filter((item) =>
					this.isDefaultModel(item.model),
				);
				const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
				this.filteredModels = [
					...defaultItems,
					...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
				];
			} else {
				this.filteredModels = filtered;
			}
		} else {
			this.filteredModels = this.activeModels;
		}
		this.selectedIndex = query
			? 0
			: Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		if (query) this.topIndex = 0;
		else this.revealSelection();
		this.updateList();
	}

	private rowLine(item: ModelItem, selected: boolean): string {
		const label = `${item.provider}/${item.id}`;
		if (selected) return theme.bg("selectedBg", theme.bold(theme.fg("accent", label)));
		if (modelsAreEqual(this.currentModel, item.model)) return theme.fg("selectionText", label);
		return theme.fg("text", label);
	}

	get maxTopIndex(): number {
		return Math.max(0, this.filteredModels.length - MAX_VISIBLE);
	}

	private revealSelection(): void {
		const visible = Math.min(MAX_VISIBLE, this.filteredModels.length);
		if (this.selectedIndex < this.topIndex) this.topIndex = this.selectedIndex;
		else if (this.selectedIndex >= this.topIndex + visible) {
			this.topIndex = this.selectedIndex - visible + 1;
		}
		this.topIndex = Math.max(0, Math.min(this.topIndex, this.maxTopIndex));
	}

	private updateList(): void {
		this.listContainer.clear();
		this.topIndex = Math.max(0, Math.min(this.topIndex, this.maxTopIndex));
		const startIndex = this.topIndex;
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filteredModels.length);

		const searching = this.searchInput.getValue().trim().length > 0;
		const multiProvider =
			!searching &&
			new Set(this.filteredModels.slice(startIndex, endIndex).map((item) => item.provider))
				.size > 1;
		let lastProvider: string | undefined;

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;
			if (multiProvider && item.provider !== lastProvider) {
				this.listContainer.addChild(new Text(theme.fg("muted", item.provider), 1, 0));
				lastProvider = item.provider;
			}
			const line = this.rowLine(item, i === this.selectedIndex);
			this.listContainer.addChild(
				new MouseRegion(new Text(line, 1, 0), (event) => this.handleRowMouse(event, i)),
			);
		}

		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 1, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No models match"), 1, 0));
		}

		if (
			this.onConnectProvider &&
			!this.providerFilter &&
			this.searchInput.getValue().trim() === ""
		) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new MouseRegion(new Text(theme.fg("muted", "Connect"), 1, 0), (event) =>
					this.handleConnectRowMouse(event),
				),
			);
		}
	}

	private handleConnectRowMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "press" && event.button === "left") return { handled: true, focus: true };
		if (event.button !== "left" || event.type !== "click") return undefined;
		this.dispose();
		this.onConnectProvider?.();
		return { handled: true };
	}

	private handleRowMouse(event: TuiMouseEvent, index: number): TuiMouseEventResult | undefined {
		// Hover ignored.
		if (event.type === "move") return { handled: true };
		if (event.type === "wheel" && event.wheelDelta) {
			if (this.filteredModels.length === 0) return undefined;
			return { handled: true, render: this.scrollViewport(event.wheelDelta < 0 ? -1 : 1) };
		}
		if (event.type === "leave") return { handled: true };
		if (event.button !== "left") return undefined;
		if (event.type === "press") {
			if (this.selectedIndex !== index) {
				this.selectedIndex = index;
				this.updateList();
			}
			return { handled: true, focus: true, render: true };
		}
		if (event.type === "click") {
			const item = this.filteredModels[index];
			if (item) this.handleSelect(item.model);
			return { handled: true };
		}
		return undefined;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				this.setScope(this.scope === "all" ? "scoped" : "all");
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		} else if (kb.matches(keyData, "app.models.save") && this.onSelectAsDefaultCallback) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.dispose();
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		} else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private scrollViewport(delta: number): boolean {
		const nextTop = Math.max(0, Math.min(this.maxTopIndex, this.topIndex + delta));
		const visible = Math.min(MAX_VISIBLE, this.filteredModels.length);
		const nextIndex = Math.max(nextTop, Math.min(this.selectedIndex, nextTop + visible - 1));
		const scrolled = nextTop !== this.topIndex || nextIndex !== this.selectedIndex;
		this.topIndex = nextTop;
		this.selectedIndex = nextIndex;
		this.updateList();
		return scrolled;
	}

	private moveSelection(delta: number): void {
		const count = this.filteredModels.length;
		if (count === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.revealSelection();
		this.updateList();
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
