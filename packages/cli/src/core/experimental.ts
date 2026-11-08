export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.GAMA_EXPERIMENTAL === "1";
}
