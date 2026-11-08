import type { SettingsStore } from "./settings.ts";

export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsStore,
	telemetryEnv: string | undefined = process.env.GAMA_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined
		? isTruthyEnvFlag(telemetryEnv)
		: settingsManager.getEnableInstallTelemetry();
}
