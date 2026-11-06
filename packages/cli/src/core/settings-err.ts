import type { AgentSessionRuntimeDiagnostic } from "./session/services.ts";
import type { SettingsError, SettingsStore } from "./settings.ts";

const KEY_SEPARATOR = "\u0000";

function describeError({ scope, path, error }: SettingsError): string {
	if (path) return `Invalid settings file ${path}: ${error.message}`;

	return `Invalid ${scope} settings: ${error.message}`;
}

export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();

	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}${KEY_SEPARATOR}${diagnostic.message}`;
		if (seen.has(key)) return false;

		seen.add(key);
		return true;
	});
}

export function collectSettingsDiagnostics(
	settingsManager: SettingsStore,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map((drained) => ({
		type: "warning",
		message: describeError(drained),
	}));
}