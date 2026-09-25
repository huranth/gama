import { normalizeModelId, requiresExplicitCache } from "@huranth/gama-ai";
import type { ModelsDevCatalog } from "../custom-provider.ts";

export interface ModelsDevCacheHint {
	cacheControlFormat?: "anthropic";
	cachePriced: boolean;
}

type CatalogModel = NonNullable<ModelsDevCatalog[string]["models"]>[string];

interface IndexedEntry {
	entry: CatalogModel;
	provider: ModelsDevCatalog[string];
}

const indexByCatalog = new WeakMap<ModelsDevCatalog, Map<string, IndexedEntry>>();

function usesAnthropicSdk(npm: string | undefined): boolean {
	return typeof npm === "string" && npm.toLowerCase().includes("anthropic");
}

function lookup(index: Map<string, IndexedEntry>, modelId: string): IndexedEntry | undefined {
	const key = normalizeModelId(modelId);

	return index.get(key) ?? prefixMatch(index, key);
}

function isPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function below(value: number, ceiling: number | undefined): boolean {
	if (ceiling === undefined) return true;
	if (!Number.isFinite(ceiling)) return true;

	return value < ceiling;
}

function isCachePriced(entry: CatalogModel): boolean {
	const cost = entry.cost;
	if (!cost) return false;

	const read = cost.cache_read;
	const write = cost.cache_write;
	const readDiscounted = isPrice(read) && below(read, cost.input);
	const writePriced = isPrice(write);

	return readDiscounted || writePriced;
}

// Prefix.
function prefixMatch(index: Map<string, IndexedEntry>, modelId: string): IndexedEntry | undefined {
	let best: IndexedEntry | undefined;
	let bestLength = 0;

	for (const [candidate, value] of index) {
		if (candidate.length <= bestLength) continue;
		if (!modelId.startsWith(candidate)) continue;

		const next = modelId[candidate.length];
		if (next !== undefined && next !== "-") continue;

		best = value;
		bestLength = candidate.length;
	}

	return best;
}

function catalogIndex(catalog: ModelsDevCatalog): Map<string, IndexedEntry> {
	const cached = indexByCatalog.get(catalog);
	if (cached) return cached;

	const index = new Map<string, IndexedEntry>();

	for (const provider of Object.values(catalog)) {
		for (const [id, entry] of Object.entries(provider.models ?? {})) {
			const key = normalizeModelId(id);
			if (key && !index.has(key)) index.set(key, { entry, provider });
		}
	}

	indexByCatalog.set(catalog, index);

	return index;
}

export function modelsDevCacheHint(
	catalog: ModelsDevCatalog | undefined,
	modelId: string,
): ModelsDevCacheHint {
	if (!catalog) return { cachePriced: false };

	const index = catalogIndex(catalog);
	const found = lookup(index, modelId);
	if (!found) return { cachePriced: false };

	const native = usesAnthropicSdk(found.provider.npm);
	const explicit =
		native ||
		requiresExplicitCache({
			id: modelId,
			...(found.entry.family ? { family: found.entry.family } : {}),
		});

	return {
		...(explicit ? { cacheControlFormat: "anthropic" as const } : {}),
		cachePriced: isCachePriced(found.entry),
	};
}
