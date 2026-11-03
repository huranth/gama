interface CacheFamilyInput {
	id: string;
	family?: string;
	provider?: string;
	baseUrl?: string;
}

const TRAILING_TAG = /:(?:free|beta|extended|preview)$/;

const TRAILING_DATE = /-20\d{6}(?:-v\d+)?(?:-\d+)?$/;

export function normalizeModelId(id: string): string {
	let value = id.trim().toLowerCase();
	const slash = value.lastIndexOf("/");
	if (slash !== -1) value = value.slice(slash + 1);

	value = value.replace(TRAILING_TAG, "");
	value = value.replace(/[._:]/g, "-");
	value = value.replace(/-+/g, "-");
	value = value.replace(TRAILING_DATE, "");
	value = value.replace(/-latest$/, "");

	return value.replace(/^-+|-+$/g, "");
}

export function modelFamilyTokens(id: string, family?: string): string[] {
	const tokens = new Set<string>();

	for (const token of normalizeModelId(id).split("-")) {
		if (token) tokens.add(token);
	}

	if (family) {
		const normalizedFamily = family.trim().toLowerCase();

		if (normalizedFamily) {
			tokens.add(normalizedFamily);
			for (const token of normalizedFamily.split(/[^a-z0-9]+/)) {
				if (token) tokens.add(token);
			}
		}
	}

	return [...tokens];
}

export function requiresExplicitCache(input: CacheFamilyInput): boolean {
	const family = input.family?.trim().toLowerCase() ?? "";
	const provider = input.provider?.trim().toLowerCase();
	const baseUrl = input.baseUrl?.toLowerCase();

	if (family.startsWith("claude")) return true;
	if (family.includes("anthropic")) return true;
	if (provider === "anthropic") return true;
	if (baseUrl?.includes("api.anthropic.com")) return true;

	const tokens = modelFamilyTokens(input.id, input.family);

	return tokens.includes("claude") || tokens.includes("anthropic");
}
