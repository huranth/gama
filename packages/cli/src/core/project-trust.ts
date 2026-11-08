import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
import { emitProjectTrustEvent } from "./ext/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./ext/types.ts";
import type { DefaultProjectTrust } from "./settings.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

export interface ResolveProjectTrustedOptions {
	cwd: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

function formatProjectTrustPrompt(cwd: string): string {
	return (
		`Trust project folder?\n${cwd}\n\nThis allows ${APP_NAME} to load ${CONFIG_DIR_NAME} ` +
		"settings and resources, install missing project packages, and execute project extensions."
	);
}

function saveProjectTrustPromptResult(
	trustStore: ProjectTrustStore,
	result: ProjectTrustOption,
): void {
	if (result.updates.length === 0) return;

	trustStore.setMany(result.updates);
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === selected);
}

export async function resolveProjectTrusted(
	options: ResolveProjectTrustedOptions,
): Promise<boolean> {
	const {
		cwd,
		trustStore,
		trustOverride,
		defaultProjectTrust,
		extensionsResult,
		projectTrustContext,
		onExtensionError,
	} = options;

	if (trustOverride !== undefined) {
		return trustOverride;
	}
	if (!hasTrustRequiringProjectResources(cwd)) {
		return true;
	}

	if (extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			extensionsResult,
			{ type: "project_trust", cwd },
			projectTrustContext,
		);
		for (const error of errors) {
			onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}

		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				trustStore.set(cwd, trusted);
			}
			return trusted;
		}
	}

	const decision = trustStore.get(cwd);
	if (decision !== null) {
		return decision;
	}

	switch (defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	if (!projectTrustContext.hasUI) {
		return false;
	}

	const selected = await selectProjectTrustOption(cwd, projectTrustContext);
	if (selected === undefined) return false;

	saveProjectTrustPromptResult(trustStore, selected);
	return selected.trusted;
}
