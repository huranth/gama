import type { Terminal, WheelScrollLines } from "@huranth/gama-tui";
import { ProcessTerminal, type TUI, AltScreen, MainScreen } from "@huranth/gama-tui";
import { copyToClipboard } from "../utils/clipboard.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { theme } from "./theme/theme.ts";

export interface InteractiveTuiOptions {
	readonly tuiMode: "regular" | "fullscreen";
	readonly showHardwareCursor: boolean;
	readonly logDirectory: string;
	readonly terminal?: Terminal;
	readonly onRightClickPaste?: () => void;
	readonly fullscreenCopyOnSelect?: boolean;
	readonly fullscreenWheelScrollLines?: WheelScrollLines;
}

export function createInteractiveTui(
	options: InteractiveTuiOptions & { readonly tuiMode: "fullscreen" },
): AltScreen;

export function createInteractiveTui(
	options: InteractiveTuiOptions & { readonly tuiMode: "regular" },
): MainScreen;

export function createInteractiveTui(options: InteractiveTuiOptions): MainScreen | AltScreen;

export function createInteractiveTui(options: InteractiveTuiOptions): MainScreen | AltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();

	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) =>
			theme.bg("searchMatchBg", theme.fg("searchMatchText", text));

		return new AltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => styleSearchMatch(text),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			searchNavigationButtonStyle: (text) => text,
			scrollToEndIndicator: () => theme.bg("selectedBg", theme.fg("text", " End ")),
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
			copyOnSelect: options.fullscreenCopyOnSelect,
			wheelScrollLines: options.fullscreenWheelScrollLines ?? "auto",
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
	}

	return new MainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`Not callable: ${String(property)}`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}
