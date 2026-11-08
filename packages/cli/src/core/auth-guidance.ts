export function formatNoModelsAvailableMessage(): string {
	return "No models available. Set an API key.";
}

export function formatNoModelSelectedMessage(): string {
	return "No model selected. Run /model.";
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === "unknown" ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.`;
}
