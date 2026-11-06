import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { fetchModelsDevCatalog, type ModelsDevCatalog } from "@huranth/gama-ai";

import { getAgentDir } from "../config.ts";
import { writeFileAtomicSync } from "../utils/atomic-write.ts";
import { stripBom } from "../utils/text.ts";

export type { ModelsDevCatalog };

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedCatalog {
	fetchedAt: number;
	catalog: ModelsDevCatalog;
}

let memoryCache: CachedCatalog | undefined;

let inflight: Promise<ModelsDevCatalog | undefined> | undefined;

export function getModelsDevCachePath(): string {
	return join(getAgentDir(), "cache", "models-dev.json");
}

function readCacheFile(path: string): CachedCatalog | undefined {
	try {
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt))
			return undefined;
		if (typeof record.catalog !== "object" || record.catalog === null) return undefined;
		return { fetchedAt: record.fetchedAt, catalog: record.catalog as ModelsDevCatalog };
	} catch {
		return undefined;
	}
}

function writeCacheFile(path: string, cached: CachedCatalog): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileAtomicSync(path, `${JSON.stringify(cached)}\n`);
	} catch {}
}

function networkAllowed(allowNetwork: boolean | undefined): boolean {
	return allowNetwork !== false && process.env.GAMA_OFFLINE === undefined;
}

export interface GetModelsDevCatalogOptions {
	signal?: AbortSignal;
	allowNetwork?: boolean;
	maxAgeMs?: number;
}

async function fetchCatalog(
	path: string,
	signal: AbortSignal | undefined,
	stale: CachedCatalog | undefined,
): Promise<ModelsDevCatalog | undefined> {
	try {
		const fetched = await fetchModelsDevCatalog(signal ? { signal } : undefined);
		if (fetched && Object.keys(fetched).length > 0) {
			const cached: CachedCatalog = { fetchedAt: Date.now(), catalog: fetched };
			memoryCache = cached;
			writeCacheFile(path, cached);
			return fetched;
		}
	} catch {}

	if (stale) memoryCache = stale;
	return stale?.catalog;
}

// Catalog source
export async function getModelsDevCatalog(
	options: GetModelsDevCatalogOptions = {},
): Promise<ModelsDevCatalog | undefined> {
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const now = Date.now();

	if (memoryCache && now - memoryCache.fetchedAt <= maxAgeMs) {
		return memoryCache.catalog;
	}

	const path = getModelsDevCachePath();
	const disk = readCacheFile(path);
	if (disk && now - disk.fetchedAt <= maxAgeMs) {
		memoryCache = { catalog: disk.catalog, fetchedAt: disk.fetchedAt };
		return disk.catalog;
	}

	const stale = memoryCache ?? disk;
	if (!networkAllowed(options.allowNetwork) || options.signal?.aborted) {
		if (stale) memoryCache = stale;
		return stale?.catalog;
	}

	if (inflight) return inflight;

	inflight = fetchCatalog(path, options.signal, stale).finally(() => {
		inflight = undefined;
	});

	return inflight;
}

// Clear cache
export function clearModelsDevCatalogCache(): void {
	memoryCache = undefined;
	inflight = undefined;
}
