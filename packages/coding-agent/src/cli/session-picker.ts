import { setKeybindings } from "@huranth/gama-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/tui/parts/session-selector.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

type SessionsLoader = (
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
) => Promise<SessionInfo[]>;

export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		// Settle once
		const finish = (path: string | null) => {
			if (resolved) return;
			resolved = true;
			ui.stop();
			resolve(path);
		};

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path) => finish(path),
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
