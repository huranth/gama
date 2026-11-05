import chalk from "chalk";
import type { ProjectTrustContext } from "../core/ext/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsStore } from "../core/settings.ts";
import { showStartupInput, showStartupSelector } from "./ui.ts";

const NOTIFY_COLORS = {
	error: chalk.red,
	warning: chalk.yellow,
	info: chalk.cyan,
};

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsStore;
	hasUI: boolean;
}): ProjectTrustContext {
	const canPrompt = options.hasUI && options.mode === "interactive";
	const trustMode = options.mode === "interactive" ? "tui" : options.mode;

	return {
		cwd: options.cwd,
		mode: trustMode,
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

				console.error(NOTIFY_COLORS[type](message));
			},
		},
	};
}
