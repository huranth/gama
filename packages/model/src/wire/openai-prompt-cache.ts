export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

const EXPLICIT_PROMPT_CACHE_HOSTS = ["api.openai.com", "openrouter.ai"];

export interface OpenAIPromptCacheBreakpoint {
	mode: "explicit";
	ttl?: "30m" | "12h";
}

export function supportsExplicitOpenAIPromptCache(input: {
	id: string;
	provider?: string;
	baseUrl?: string;
	explicit?: boolean;
}): boolean {
	if (input.explicit !== true) return false;

	const provider = input.provider?.trim().toLowerCase();
	if (provider === "openai") return true;

	const host = input.baseUrl?.toLowerCase() ?? "";

	return EXPLICIT_PROMPT_CACHE_HOSTS.some((candidate) => host.includes(candidate));
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined || key.trim().length === 0) return undefined;

	const chars = Array.from(key);
	const isShort = chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH;

	if (isShort) return key;

	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
