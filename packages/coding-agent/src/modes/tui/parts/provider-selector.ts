import { Container, getKeybindings, Spacer, Text } from "@huranth/gama-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const MAX_VISIBLE = 12;

export interface ProviderChoice {
	id: string;
	baseUrl?: string;
	authLabel?: string;
}

export interface ProviderSelectorOptions {
	providers: readonly ProviderChoice[];
	onSelect: (providerId: string) => void;
	onDelete?: (providerId: string) => void;
	onCancel: () => void;
}

function deletePrompt(providerId: string): string {
	return `Delete provider "${providerId}"? Enter to confirm, Esc to cancel`;
}

export class ProviderSelectorComponent extends Container {
	private readonly listContainer: Container;
	private readonly providers: readonly ProviderChoice[];
	private readonly onSelectCallback: (providerId: string) => void;
	private readonly onDeleteCallback: ((providerId: string) => void) | undefined;
	private readonly onCancelCallback: () => void;
	private selectedIndex = 0;
	private confirmingDeleteId: string | null = null;

	constructor(options: ProviderSelectorOptions) {
		super();
		this.providers = options.providers;
		this.onSelectCallback = options.onSelect;
		this.onDeleteCallback = options.onDelete;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Providers")), 1, 0));
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private visibleRange(): { start: number; end: number } {
		const half = Math.floor(MAX_VISIBLE / 2);
		const centered = this.selectedIndex - half;
		const maxStart = this.providers.length - MAX_VISIBLE;
		const start = Math.max(0, Math.min(centered, maxStart));
		const end = Math.min(start + MAX_VISIBLE, this.providers.length);
		return { start, end };
	}

	private providerRow(provider: ProviderChoice, selected: boolean): string {
		const detail = [provider.baseUrl, provider.authLabel].filter(Boolean).join("  ");
		let line = `${provider.id}${detail ? theme.fg("muted", `  ${detail}`) : ""}`;
		if (selected) line = theme.bg("selectedBg", theme.bold(theme.fg("accent", line)));
		return line;
	}

	private updateList(): void {
		this.listContainer.clear();
		const { start, end } = this.visibleRange();

		for (let i = start; i < end; i++) {
			const provider = this.providers[i];
			if (!provider) continue;
			const selected = i === this.selectedIndex;
			this.listContainer.addChild(new Text(this.providerRow(provider, selected), 1, 0));
		}

		if (this.confirmingDeleteId !== null) {
			const prompt = theme.fg("error", deletePrompt(this.confirmingDeleteId));

			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(prompt, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (this.confirmingDeleteId !== null) {
			this.confirmDelete(this.confirmingDeleteId, keyData);
			return;
		}

		const selectedProvider = this.providers[this.selectedIndex];
		if (keyData === "d" && this.onDeleteCallback && selectedProvider) {
			this.confirmingDeleteId = selectedProvider.id;
			this.updateList();
			return;
		}

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (selectedProvider) this.onSelectCallback(selectedProvider.id);
			return;
		}

		this.moveSelection(keyData);
	}

	private confirmDelete(providerId: string, keyData: string): void {
		const kb = getKeybindings();
		const confirmed = kb.matches(keyData, "tui.select.confirm") || keyData === "\n";

		if (confirmed) {
			this.confirmingDeleteId = null;
			this.updateList();
			this.onDeleteCallback?.(providerId);
			return;
		}

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.confirmingDeleteId = null;
			this.updateList();
		}
	}

	private moveSelection(keyData: string): void {
		const kb = getKeybindings();
		const isUp = kb.matches(keyData, "tui.select.up") || keyData === "k";
		const isDown = kb.matches(keyData, "tui.select.down") || keyData === "j";
		if (!isUp && !isDown) return;
		if (this.providers.length === 0) return;

		const lastIndex = this.providers.length - 1;
		this.selectedIndex = isUp
			? Math.max(0, this.selectedIndex - 1)
			: Math.min(lastIndex, this.selectedIndex + 1);

		this.updateList();
	}
}
