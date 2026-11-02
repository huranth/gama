import { normalizeModelId } from "./cache/family.ts";

export interface ModelsDevModelEntry {
	id?: string;
	name?: string;
	family?: string;
	reasoning?: boolean;
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	modalities?: { input?: string[] };
}

export interface ModelsDevProviderEntry {
	id?: string;
	name?: string;
	npm?: string;
	api?: string;
	models?: Record<string, ModelsDevModelEntry>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProviderEntry>;

interface ModelPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface FetchModelsDevOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export const MODELS_DEV_API_URL = "https://models.dev/api.json?type=all";

const DEFAULT_TIMEOUT_MS = 8_000;

async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Ignore cancel
	}
}

const MAX_CATALOG_BYTES = 25 * 1024 * 1024;

const MAX_CATALOG_PROVIDERS = 10_000;

const UNSAFE_CATALOG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asCatalog(value: unknown): ModelsDevCatalog | undefined {
	const record = asRecord(value);
	if (!record) return undefined;

	const catalog = Object.create(null) as ModelsDevCatalog;
	let count = 0;
	for (const [id, entry] of Object.entries(record)) {
		if (UNSAFE_CATALOG_KEYS.has(id)) continue;
		if (count >= MAX_CATALOG_PROVIDERS) return undefined;
		const provider = asRecord(entry);
		if (!provider) continue;
		catalog[id] = provider as ModelsDevProviderEntry;
		count++;
	}

	return count > 0 ? catalog : undefined;
}

export async function fetchModelsDevCatalog(
	options: FetchModelsDevOptions = {},
): Promise<ModelsDevCatalog | undefined> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) return undefined;
		options.signal.addEventListener("abort", onAbort, { once: true });
	}
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetchImpl(MODELS_DEV_API_URL, { signal: controller.signal });
		if (!response.ok) {
			await cancelBody(response);
			return undefined;
		}

		const length = Number(response.headers.get("content-length") ?? "");
		if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) {
			await cancelBody(response);
			return undefined;
		}

		const text = await response.text();
		if (text.length > MAX_CATALOG_BYTES) return undefined;

		return asCatalog(JSON.parse(text));
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return undefined;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findProvider(
	catalog: ModelsDevCatalog,
	providerId: string,
): ModelsDevProviderEntry | undefined {
	if (Object.hasOwn(catalog, providerId)) {
		const exact = catalog[providerId];
		if (exact) return exact;
	}

	const wanted = normalizeKey(providerId);
	if (!wanted) return undefined;

	for (const [id, entry] of Object.entries(catalog)) {
		if (normalizeKey(id) === wanted) return entry;
	}

	for (const entry of Object.values(catalog)) {
		if (typeof entry.id === "string" && normalizeKey(entry.id) === wanted) return entry;
	}

	return undefined;
}

function findModelInProvider(
	provider: ModelsDevProviderEntry,
	modelId: string,
): ModelsDevModelEntry | undefined {
	const models = provider.models;
	if (!models) return undefined;

	if (Object.hasOwn(models, modelId)) {
		const exact = models[modelId];
		if (exact) return exact;
	}

	const wanted = normalizeModelId(modelId);
	for (const [id, entry] of Object.entries(models)) {
		if (normalizeModelId(id) === wanted) return entry;
	}

	return undefined;
}

export function findModelsDevModel(
	catalog: ModelsDevCatalog | undefined,
	providerId: string,
	modelId: string,
): ModelsDevModelEntry | undefined {
	if (!catalog || !modelId.trim()) return undefined;

	const provider = findProvider(catalog, providerId);
	if (provider) {
		const found = findModelInProvider(provider, modelId);
		if (found) return found;
	}

	const wanted = normalizeModelId(modelId);
	for (const entry of Object.values(catalog)) {
		const models = entry.models;
		if (!models) continue;
		for (const [id, model] of Object.entries(models)) {
			if (normalizeModelId(id) === wanted) return model;
		}
	}

	return undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function costRate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readPrice(entry: ModelsDevModelEntry | undefined): ModelPrice | undefined {
	const cost = entry?.cost;
	if (!cost) return undefined;

	const input = costRate(cost.input) ?? 0;
	const output = costRate(cost.output) ?? 0;
	if (input <= 0 && output <= 0) return undefined;

	return {
		input,
		output,
		cacheRead: costRate(cost.cache_read) ?? input,
		cacheWrite: costRate(cost.cache_write) ?? input,
	};
}

function includesImage(input: readonly string[] | undefined): boolean {
	return Array.isArray(input) && input.includes("image");
}

type MeteredModelShape = {
	id: string;
	provider: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: readonly string[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export function applyModelsDevMetadata<T extends MeteredModelShape>(
	model: T,
	catalog: ModelsDevCatalog | undefined,
): T {
	if (!catalog) return model;

	const entry = findModelsDevModel(catalog, model.provider, model.id);
	if (!entry) return model;

	const updated = { ...model } as T & MeteredModelShape;

	if (positiveNumber(model.contextWindow) === undefined) {
		const context = positiveNumber(entry.limit?.context);
		if (context !== undefined) updated.contextWindow = context;
	}

	if (positiveNumber(model.maxTokens) === undefined) {
		const output = positiveNumber(entry.limit?.output);
		if (output !== undefined) updated.maxTokens = output;
	}

	if (typeof model.reasoning !== "boolean" && typeof entry.reasoning === "boolean") {
		updated.reasoning = entry.reasoning;
	}

	if (!includesImage(model.input) && includesImage(entry.modalities?.input)) {
		updated.input = ["text", "image"];
	} else if (!model.input || model.input.length === 0) {
		updated.input = ["text"];
	}

	const explicitCost = model.cost !== undefined && (model.cost.input > 0 || model.cost.output > 0);
	if (!explicitCost) {
		const price = readPrice(entry);
		if (price) updated.cost = price;
	}

	return updated;
}
