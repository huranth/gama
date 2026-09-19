import chalk from "chalk";
import type { ProjectTrustContext } from "../core/ext/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
}): ProjectTrustContext {
	const canPrompt = options.hasUI && options.mode === "interactive";

	return {
		cwd: options.cwd,
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				if (!canPrompt) {
					return undefined;
				}
				return showStartupSelector(
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
				);
			},
			confirm: async (title, message) => {
				if (!canPrompt) {
					return false;
				}

				const prompt = `${title}\n${message}`;
				const choices = [
					{ label: "Yes", value: true },
					{ label: "No", value: false },
				];
				const choice = await showStartupSelector(options.settingsManager, prompt, choices);

				return choice ?? false;
			},
			input: async (title, placeholder) => {
				if (!canPrompt) {
					return undefined;
				}
				return showStartupInput(options.settingsManager, title, placeholder);
			},
			notify: (message, type = "info") => {
				if (options.mode === "interactive") return;

				let color = chalk.cyan;
				if (type === "error") {
					color = chalk.red;
				} else if (type === "warning") {
					color = chalk.yellow;
				}

				console.error(color(message));
			},
		},
	};
}
