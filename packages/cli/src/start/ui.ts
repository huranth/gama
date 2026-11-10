import {
	MainScreen,
	ProcessTerminal,
	setCapabilityOverrides,
	setKeybindings,
	type TUI,
} from "@huranth/gama-tui";
import { getAgentDir } from "../config.ts";
import { Keymap } from "../core/hotkeys.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsStore } from "../core/settings.ts";
import { ExtensionInputComponent } from "../term/parts/extension-input.ts";
import { ExtensionSelectorComponent } from "../term/parts/extension-selector.ts";
import {
	DEFAULT_THEME_NAME,
	getTerminalTheme,
	initTheme,
	loadThemeFromPath,
	markTerminalColorsPending,
	resolveThemeSetting,
	setRegisteredThemes,
	setTerminalColors,
	setTheme,
	type Theme,
} from "../term/theme/theme.ts";
import { requestTerminalColors } from "../term/theme/theme-controller.ts";

const FLUSH_MS = 25;

function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();

	for (const resource of resources) {
		if (!resource.enabled) continue;

		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}

			themes.push(loadedTheme);
		} catch {
			// Unreadable
		}
	}

	return themes;
}

async function loadStartupThemes(settingsManager: SettingsStore): Promise<Theme[]> {
	const globalSettingsManager = SettingsStore.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});

	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

function queryStartupTerminalColors(ui: TUI, onColors: () => void): void {
	void requestTerminalColors(ui, (colors) => {
		setTerminalColors(colors);
		onColors();
		ui.invalidate();
		ui.requestRender();
	});
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
}

export async function createStartupTui(settingsManager: SettingsStore): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	markTerminalColorsPending();
	initTheme(
		resolveThemeSetting(settingsManager.getThemeSetting(), getTerminalTheme()) ??
			DEFAULT_THEME_NAME,
	);
	setKeybindings(Keymap.create());

	const ui: TUI = new MainScreen(
		new ProcessTerminal(),
		settingsManager.getShowHardwareCursor(),
		getAgentDir(),
	);
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI, settingsManager: SettingsStore): void {
	ui.start();
	const themeSetting = settingsManager.getThemeSetting();
	queryStartupTerminalColors(ui, () => {
		setTheme(resolveThemeSetting(themeSetting, getTerminalTheme()) ?? DEFAULT_THEME_NAME);
	});
}

export async function showStartupSelector<T>(
	settingsManager: SettingsStore,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) return;
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

export async function showStartupInput(
	settingsManager: SettingsStore,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) return;
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);

		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
