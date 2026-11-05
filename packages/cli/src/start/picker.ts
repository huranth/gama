import { getKeybindings, setKeybindings } from "@huranth/gama-tui";
import { Keymap } from "../core/hotkeys.ts";
import type { SessionInfo, SessionListProgress } from "../core/sessions.ts";
import type { SettingsStore } from "../core/settings.ts";
import { SessionSelectorComponent } from "../term/parts/session-selector.ts";
import { createStartupTui, startStartupTui } from "./ui.ts";

type SessionsLoader = (
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
) => Promise<SessionInfo[]>;

export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsStore,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((finishWith) => {
		const previousKeybindings = getKeybindings();
		const keybindings = Keymap.create();
		setKeybindings(keybindings);
		let settled = false;

		// Settle once
		const finish = (path: string | null) => {
			if (settled) return;
			settled = true;
			setKeybindings(previousKeybindings);
			selector.dispose();
			ui.stop();
			finishWith(path);
		};

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			finish,
			() => finish(null),
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}
