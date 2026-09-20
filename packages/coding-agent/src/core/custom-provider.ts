import { readFile, writeFile } from "node:fs/promises";

import { type Model, type ModelCost, normalizeModelId } from "@huranth/gama-ai";

import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";
import { modelsDevCacheHint } from "./cache/models-dev.ts";

export interface EndpointModel {
	id: string;
	name: string;
	cost?: ModelCost;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input: ("text" | "image")[];
}

export interface ResolvedModel {
	id: string;
	name: string;
	cost?: ModelCost;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	cacheControlFormat?: "anthropic" | "none";
	cachePriced: boolean;
}

export interface ModelsDevCost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}

export interface FetchModelsOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ConnectProviderInput {
	baseUrl: string;
	apiKey: string;
}

export interface ModelsDevCatalog {
	[providerId: string]: {
		npm?: string;
		api?: string;
		models?: Record<
			string,
			{
				limit?: { context?: number; output?: number };
				reasoning?: boolean;
				modalities?: { input?: string[] };
				family?: string;
				cost?: ModelsDevCost;
			}
		>;
	};
}

interface ModelsJsonFile {
	providers?: Record<string, unknown>;
}

type CatalogModel = NonNullable<ModelsDevCatalog[string]["models"]>[string];

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

const DEFAULT_ENDPOINT_TIMEOUT_MS = 10_000;
const TOKENS_PER_MILLION = 1_000_000;
export const NO_PRICE: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const CUSTOM_PROVIDER_API = "openai-completions";
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 6_000;
const MODELS_DEV_MAX_BYTES = 20 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function readCostRate(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

function readTokenRate(value: unknown): number | undefined {
	const rate = readCostRate(value);
	return rate !== undefined && rate > 0 ? rate * TOKENS_PER_MILLION : undefined;
}

// Per million.
function toModelCost(prices: {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): ModelCost | undefined {
	if (prices.input === undefined && prices.output === undefined) return undefined;
	const base = prices.input ?? 0;
	return {
		input: base,
		output: prices.output ?? 0,
		cacheRead: prices.cacheRead ?? base,
		cacheWrite: prices.cacheWrite ?? base,
	};
}

function readPricingCost(pricing: Record<string, unknown> | undefined): ModelCost | undefined {
	if (!pricing) return undefined;
	return toModelCost({
		input: readCostRate(pricing.input_usd_per_1m),
		output: readCostRate(pricing.output_usd_per_1m),
		cacheRead: readCostRate(pricing.cache_read_usd_per_1m),
		cacheWrite: readCostRate(pricing.cache_write_usd_per_1m),
	});
}

function readEndpointCost(entry: Record<string, unknown>): ModelCost | undefined {
	const pricing = asRecord(entry.pricing);
	return readPricingCost(pricing) ?? readTokenCost(pricing) ?? readTokenCost(entry);
}

function readDevCost(entry: CatalogModel | undefined): ModelCost | undefined {
	const cost = entry?.cost;
	if (!cost) return undefined;
	return toModelCost({
		input: readCostRate(cost.input),
		output: readCostRate(cost.output),
		cacheRead: readCostRate(cost.cache_read),
		cacheWrite: readCostRate(cost.cache_write),
	});
}

function knownCost(cost: ModelCost | undefined): ModelCost | undefined {
	return cost && (cost.input > 0 || cost.output > 0) ? cost : undefined;
}

function hasImageModality(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.some((entry) => typeof entry === "string" && entry.includes("image"))
	);
}

export function readEndpointModelMetadata(
	entry: Record<string, unknown>,
): Omit<EndpointModel, "id" | "name"> {
	const topProvider = asRecord(entry.top_provider) ?? asRecord(entry.topProvider);
	const limits = asRecord(entry.limits);
	const meta = asRecord(entry.meta);
	const architecture = asRecord(entry.architecture);
	const cost = readEndpointCost(entry);
	const reasoning =
		typeof entry.reasoning === "boolean"
			? entry.reasoning
			: typeof entry.supports_reasoning === "boolean"
				? entry.supports_reasoning
				: undefined;
	const supportsImages =
		hasImageModality(entry.input_modalities) || hasImageModality(architecture?.input_modalities);

	return {
		...(cost ? { cost } : {}),
		contextWindow: firstNumber(
			entry.context_length,
			entry.context_window,
			entry.contextWindow,
			entry.max_model_len,
			entry.max_context_length,
			topProvider?.context_length,
			meta?.n_ctx_train,
		),
		maxTokens: firstNumber(
			entry.max_output_tokens,
			entry.max_completion_tokens,
			entry.max_tokens,
			entry.maxTokens,
			topProvider?.max_completion_tokens,
			limits?.output,
		),
		reasoning,
		input: supportsImages ? ["text", "image"] : ["text"],
	};
}

function positiveFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstPositive(...values: unknown[]): number | undefined {
	for (const value of values) {
		const number = positiveFinite(value);
		if (number !== undefined) return number;
	}

	return undefined;
}

export async function saveCustomProviderModels(
	modelsPath: string,
	providerId: string,
	definition: Record<string, unknown>,
): Promise<void> {
	const config = (await readModelsConfig(modelsPath)) ?? {};
	config.providers = { ...(config.providers ?? {}), [providerId]: definition };
	await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export async function deleteCustomProvider(
	modelsPath: string,
	providerId: string,
): Promise<boolean> {
	const config = await readModelsConfig(modelsPath);
	const providers = config?.providers;
	if (!providers || !(providerId in providers)) return false;
	delete providers[providerId];
	await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	return true;
}

export async function saveProviderBaseUrl(
	modelsPath: string,
	providerId: string,
	baseUrl: string,
): Promise<void> {
	const config = (await readModelsConfig(modelsPath)) ?? {};
	const providers = { ...(config.providers ?? {}) };
	const existing = asRecord(providers[providerId]) ?? {};
	providers[providerId] = { ...existing, baseUrl };
	config.providers = providers;
	await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function normalizeBaseUrl(raw: string): string {
	let value = raw.trim().replace(/^["']+|["']+$/g, "");
	if (!value) return "";
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
	value = value.replace(/\/+$/g, "");
	value = value.replace(/\/models$/i, "");
	return value;
}

async function readModelsConfig(modelsPath: string): Promise<ModelsJsonFile | undefined> {
	try {
		const content = await readFile(modelsPath, "utf-8");
		const parsed = JSON.parse(stripJsonComments(stripBom(content)));
		return asRecord(parsed) ? (parsed as ModelsJsonFile) : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

export function deriveProviderId(baseUrl: string): string {
	let host = "";
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		host = baseUrl;
	}
	const labels = host
		.toLowerCase()
		.split(".")
		.filter((label) => label.length > 0 && label !== "api" && label !== "www");
	if (labels.length > 1) labels.pop();
	const id = labels
		.join("-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return id || "custom";
}

export async function saveModelOverride(
	modelsPath: string,
	providerId: string,
	modelId: string,
	override: Record<string, unknown>,
): Promise<void> {
	const config = (await readModelsConfig(modelsPath)) ?? {};
	const providers = { ...(config.providers ?? {}) };
	const existing = asRecord(providers[providerId]) ?? {};
	const modelOverrides = { ...(asRecord(existing.modelOverrides) ?? {}) };
	const existingOverride = asRecord(modelOverrides[modelId]) ?? {};
	modelOverrides[modelId] = { ...existingOverride, ...override };
	providers[providerId] = { ...existing, modelOverrides };
	config.providers = providers;
	await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function uniqueProviderId(base: string, existing: Iterable<string>): string {
	const taken = new Set(existing);
	if (!taken.has(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

function readTokenCost(record: Record<string, unknown> | undefined): ModelCost | undefined {
	if (!record) return undefined;
	return toModelCost({
		input: readTokenRate(record.prompt ?? record.input_cost_per_token),
		output: readTokenRate(record.completion ?? record.output_cost_per_token),
		cacheRead: readTokenRate(record.input_cache_read ?? record.cache_read_input_token_cost),
		cacheWrite: readTokenRate(record.input_cache_write ?? record.cache_creation_input_token_cost),
	});
}

function entryId(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry.trim() || undefined;
	const record = asRecord(entry);
	if (!record) return undefined;
	for (const key of ["id", "name", "model"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return undefined;
}

function modelEntries(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	const record = asRecord(payload);
	if (!record) return [];
	if (Array.isArray(record.data)) return record.data;
	if (Array.isArray(record.models)) return record.models;
	const data = asRecord(record.data);
	if (data && Array.isArray(data.models)) return data.models;
	return [];
}

function firstNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0)
			return Math.floor(value);
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
		}
	}
	return undefined;
}

export function parseModelsPayload(payload: unknown): EndpointModel[] {
	const models: EndpointModel[] = [];
	const seen = new Set<string>();
	for (const entry of modelEntries(payload)) {
		const id = entryId(entry);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const record = asRecord(entry);
		const metadata: Omit<EndpointModel, "id" | "name"> = record
			? readEndpointModelMetadata(record)
			: { input: ["text"] };
		const name =
			record && typeof record.name === "string" && record.name.trim() !== ""
				? record.name.trim()
				: id;
		models.push({ id, name, ...metadata });
	}
	return models;
}

export async function fetchModelsDevCatalog(
	options: FetchModelsOptions = {},
): Promise<ModelsDevCatalog | undefined> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
	try {
		const response = await fetchImpl(MODELS_DEV_URL, { signal: controller.signal });
		if (!response.ok) return undefined;
		const length = Number(response.headers.get("content-length") ?? "");
		if (Number.isFinite(length) && length > MODELS_DEV_MAX_BYTES) return undefined;
		const text = await response.text();
		if (text.length > MODELS_DEV_MAX_BYTES) return undefined;
		return JSON.parse(text);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export async function rememberCustomProviderModel(
	modelsPath: string,
	model: {
		provider: string;
		id: string;
		name: string;
		input: readonly string[];
		cost: unknown;
		reasoning: boolean;
		contextWindow: number;
		maxTokens: number;
	},
): Promise<"added" | "already-known" | "not-custom"> {
	if (!model.provider.trim() || !model.id.trim()) return "not-custom";
	const config = await readModelsConfig(modelsPath);
	if (!config) return "not-custom";
	const providers = { ...(config.providers ?? {}) };
	const existing = asRecord(providers[model.provider]);
	if (!existing) return "not-custom";
	const models = Array.isArray(existing.models) ? [...existing.models] : [];
	if (models.some((entry) => asRecord(entry)?.id === model.id)) return "already-known";
	const input = model.input.filter((modality) => modality === "text" || modality === "image");
	const cost =
		model.cost && typeof model.cost === "object" && !Array.isArray(model.cost)
			? { ...model.cost }
			: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	models.push({
		id: model.id,
		name: model.name.trim() || model.id,
		input: input.length > 0 ? input : ["text"],
		cost,
		reasoning: model.reasoning,
		...(Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? { contextWindow: model.contextWindow }
			: {}),
		...(Number.isFinite(model.maxTokens) && model.maxTokens > 0
			? { maxTokens: model.maxTokens }
			: {}),
	});
	providers[model.provider] = { ...existing, models };
	config.providers = providers;
	await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	return "added";
}

export async function fetchEndpointModels(
	baseUrl: string,
	apiKey: string,
	options: FetchModelsOptions = {},
): Promise<EndpointModel[]> {
	const normalized = normalizeBaseUrl(baseUrl);
	if (!normalized) throw new Error("Enter a base URL.");
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_ENDPOINT_TIMEOUT_MS;
	let signal = options.signal;
	if (timeoutMs > 0) {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	}
	const candidates = [`${normalized}/models`];
	let origin: URL | undefined;

	try {
		origin = new URL(normalized);
	} catch {}

	const isOrigin = origin && (origin.pathname === "" || origin.pathname === "/");
	if (isOrigin) candidates.push(`${normalized}/v1/models`);

	let lastError: Error | undefined;

	for (const url of candidates) {
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
				signal,
			});
		} catch (error) {
			if (options.signal?.aborted) throw error;
			lastError = new Error(
				signal?.aborted && timeoutMs > 0
					? `${url} timed out after ${timeoutMs} ms`
					: `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
			lastError = new Error(
				`${url} returned HTTP ${response.status}` +
					`${response.statusText ? ` ${response.statusText}` : ""}` +
					`${detail ? `: ${detail}` : ""}`,
			);
			continue;
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			lastError = new Error(`${url} did not return JSON.`);
			continue;
		}
		const models = parseModelsPayload(payload);
		if (models.length > 0) return models;

		lastError = new Error(`${url} returned no models.`);
	}

	throw lastError ?? new Error("Could not fetch models from this endpoint.");
}

export function resolveModels(
	models: readonly EndpointModel[],
	builtinModels: readonly Model<any>[] = [],
	modelsDev?: ModelsDevCatalog,
): ResolvedModel[] {
	const builtinById = new Map<string, Model<any>>();
	for (const model of builtinModels) {
		const key = model.id.toLowerCase();
		if (!builtinById.has(key)) builtinById.set(key, model);
	}
	const devById = new Map<string, CatalogModel>();
	for (const provider of Object.values(modelsDev ?? {})) {
		for (const [id, entry] of Object.entries(provider.models ?? {})) {
			const key = normalizeModelId(id);
			if (!devById.has(key)) devById.set(key, entry);
		}
	}
	return models.map((model) => {
		const builtin = builtinById.get(model.id.toLowerCase());
		const dev = devById.get(normalizeModelId(model.id)) ?? devById.get(model.id.toLowerCase());
		const cache = modelsDevCacheHint(modelsDev, model.id);
		const cost = knownCost(model.cost) ?? knownCost(builtin?.cost) ?? readDevCost(dev);
		const contextWindow =
			firstPositive(model.contextWindow, builtin?.contextWindow, dev?.limit?.context) ??
			DEFAULT_CONTEXT_WINDOW;
		const maxTokens =
			firstPositive(model.maxTokens, builtin?.maxTokens, dev?.limit?.output) ??
			Math.min(DEFAULT_MAX_TOKENS, contextWindow);
		const devInput = dev?.modalities?.input;
		const devImages = Array.isArray(devInput) && devInput.includes("image");
		const input: ("text" | "image")[] =
			model.input.includes("image") || devImages ? ["text", "image"] : ["text"];

		return {
			id: model.id,
			name: model.name,
			...(cost ? { cost } : {}),
			contextWindow,
			maxTokens,
			reasoning: model.reasoning ?? builtin?.reasoning ?? dev?.reasoning ?? false,
			input: [...input],
			...(cache.cacheControlFormat ? { cacheControlFormat: cache.cacheControlFormat } : {}),
			cachePriced: cache.cachePriced,
		};
	});
}
