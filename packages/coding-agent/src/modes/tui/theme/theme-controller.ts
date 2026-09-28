import type { RgbColor, TerminalColors, TUI } from "@huranth/gama-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	getTerminalTheme,
	initTheme,
	markTerminalColorsPending,
	parseAutoThemeSetting,
	resolveThemeSetting,
	SYSTEM_THEME_NAME,
	setTerminalColorScheme,
	setTerminalColors,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

const TERMINAL_QUERY_TIMEOUT_MS = 100;

type ThemeResult = { success: boolean; error?: string };

export function requestTerminalColors(
	ui: TUI,
	apply: (colors: TerminalColors) => void,
): Promise<void> {
	let query: Promise<TerminalColors>;
	try {
		query = ui.queryTerminalColors({ timeoutMs: TERMINAL_QUERY_TIMEOUT_MS, onLateReply: apply });
	} catch {
		query = Promise.resolve({});
	}

	return query.then(apply, () => apply({}));
}

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return (
		a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b)
	);
}

function sameTerminalColors(a: TerminalColors, b: TerminalColors): boolean {
	if (!sameRgb(a.foreground, b.foreground) || !sameRgb(a.background, b.background)) return false;

	if (a.palette === b.palette) return true;
	if (!a.palette || !b.palette || a.palette.length !== b.palette.length) return false;
	return a.palette.every((color, index) => sameRgb(color, b.palette?.[index]));
}

export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private currentThemeSetting: string | undefined;
	private terminalColors: TerminalColors | undefined;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	private terminalColorQuery: Promise<void> = Promise.resolve();

	constructor(
		ui: TUI,
		options: {
			getSettingsManager: () => SettingsManager;
			showError: (message: string) => void;
			onChanged: () => void;
			initialThemeSetting?: string;
		},
	) {
		this.ui = ui;
		this.getSettingsManager = options.getSettingsManager;
		this.showError = options.showError;
		this.onChanged = options.onChanged;
		this.currentThemeSetting = options.initialThemeSetting;
		this.activeThemeName = this.resolveThemeName();
		markTerminalColorsPending();
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}

	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	applyFromSettings(): void {
		const themeSetting = this.getThemeSetting();
		const themeName = this.resolveThemeName();
		this.setAutoSync(
			parseAutoThemeSetting(themeSetting) !== undefined || themeName === SYSTEM_THEME_NAME,
		);
		this.applyThemeName(themeName, themeSetting !== undefined);
		this.queryTerminalColors();
	}

	waitForTerminalColors(): Promise<void> {
		return this.terminalColorQuery;
	}

	getThemeSelection(): string | undefined {
		return (
			this.currentThemeSetting ??
			this.getSettingsManager().getThemeSetting() ??
			this.activeThemeName
		);
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(themeName === SYSTEM_THEME_NAME);
		const result = this.applyThemeName(themeName, showError);
		if (result.success) {
			this.currentThemeSetting = themeName;
		}
		return result;
	}

	setThemeSetting(themeSetting: string): void {
		this.currentThemeSetting = themeSetting;
		this.applyFromSettings();
	}

	setThemeInstance(themeInstance: Theme): ThemeResult {
		this.setAutoSync(false);
		setThemeInstance(themeInstance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}

	preview(themeSettingOrName: string): void {
		const themeName =
			resolveThemeSetting(themeSettingOrName, getTerminalTheme()) ?? this.activeThemeName;
		if (!themeName) return;

		if (setTheme(themeName, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	disableAutoSync(): void {
		this.setAutoSync(false);
	}

	dispose(): void {
		this.setAutoSync(false);
		this.terminalColorSchemeUnsubscribe?.();
		this.terminalColorSchemeUnsubscribe = undefined;
	}

	getTerminalTheme(): TerminalTheme {
		return getTerminalTheme();
	}

	private getThemeSetting(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting();
	}

	private resolveThemeName(): string {
		return resolveThemeSetting(this.getThemeSetting(), getTerminalTheme()) ?? SYSTEM_THEME_NAME;
	}

	private applyThemeName(themeName: string, showError = false): ThemeResult {
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : SYSTEM_THEME_NAME;
		this.notifyChanged();

		if (!result.success && showError) {
			this.showError("Theme failed");
		}

		return result;
	}

	private queryTerminalColors(): void {
		this.terminalColorQuery = requestTerminalColors(this.ui, (colors) =>
			this.applyTerminalColors(colors),
		);
	}

	private applyTerminalColors(reported: TerminalColors): void {
		const previous = this.terminalColors;
		const next: TerminalColors = {
			foreground: reported.foreground ?? previous?.foreground,
			background: reported.background ?? previous?.background,
			palette: reported.palette ?? previous?.palette,
		};

		if (previous && sameTerminalColors(previous, next)) return;
		this.terminalColors = next;
		setTerminalColors(next);
		this.reapplyForTerminal();
		this.ui.invalidate();
		this.ui.requestRender();
	}

	private reapplyForTerminal(): void {
		if (this.activeThemeName === "<in-memory>") return;
		const themeName = this.resolveThemeName();
		if (themeName === SYSTEM_THEME_NAME || themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}

	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalColorSchemeChange(terminalTheme),
		);
	}

	private applyTerminalColorSchemeChange(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		const previous = getTerminalTheme();
		setTerminalColorScheme(terminalTheme);
		if (getTerminalTheme() !== previous) this.reapplyForTerminal();
		this.queryTerminalColors();
	}

	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}
}
