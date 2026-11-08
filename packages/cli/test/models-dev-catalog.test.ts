import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearModelsDevCatalogCache,
	getModelsDevCachePath,
	getModelsDevCatalog,
} from "../src/core/models-dev.ts";

const originalAgentDir = process.env.GAMA_CODING_AGENT_DIR;
const originalOffline = process.env.GAMA_OFFLINE;

const CATALOG = {
	anthropic: {
		name: "Anthropic",
		models: { "claude-x": { limit: { context: 200_000 } } },
	},
};

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("models.dev catalog cache", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "gama-models-dev-"));
		process.env.GAMA_CODING_AGENT_DIR = agentDir;
		delete process.env.GAMA_OFFLINE;
		clearModelsDevCatalogCache();
	});

	afterEach(() => {
		clearModelsDevCatalogCache();
		vi.unstubAllGlobals();
		if (originalAgentDir === undefined) delete process.env.GAMA_CODING_AGENT_DIR;
		else process.env.GAMA_CODING_AGENT_DIR = originalAgentDir;
		if (originalOffline === undefined) delete process.env.GAMA_OFFLINE;
		else process.env.GAMA_OFFLINE = originalOffline;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("fetches once, then serves the disk cache across process resets", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(CATALOG));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getModelsDevCatalog()).resolves.toEqual(CATALOG);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		clearModelsDevCatalogCache();
		await expect(getModelsDevCatalog()).resolves.toEqual(CATALOG);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const cached = JSON.parse(readFileSync(getModelsDevCachePath(), "utf-8"));
		expect(cached.catalog).toEqual(CATALOG);
		expect(typeof cached.fetchedAt).toBe("number");
	});

	it("falls back to stale disk data when the refresh fails", async () => {
		mkdirSync(join(agentDir, "cache"), { recursive: true });
		writeFileSync(
			getModelsDevCachePath(),
			JSON.stringify({ fetchedAt: 1, catalog: { stale: { models: {} } } }),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		await expect(getModelsDevCatalog()).resolves.toEqual({ stale: { models: {} } });
	});

	it("does not touch the network when offline", async () => {
		process.env.GAMA_OFFLINE = "1";
		const fetchMock = vi.fn(async () => jsonResponse(CATALOG));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getModelsDevCatalog()).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
