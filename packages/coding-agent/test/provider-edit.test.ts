import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { CUSTOM_PROVIDER_API } from "../src/core/custom-provider.ts";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";

type SaveEndpoint = (
	this: unknown,
	providerId: string,
	input: { baseUrl: string; apiKey: string },
) => Promise<void>;
type ConfiguredProviders = (this: unknown) => Array<{ id: string; baseUrl?: string }>;

const saveProviderEndpoint = (
	InteractiveMode as unknown as { prototype: { saveProviderEndpoint: SaveEndpoint } }
).prototype.saveProviderEndpoint;

const configuredProviders = (
	InteractiveMode as unknown as { prototype: { configuredProviders: ConfiguredProviders } }
).prototype.configuredProviders;

const cleanupDirs: string[] = [];
const previousAgentDir = process.env[ENV_AGENT_DIR];

function createAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "gama-provider-edit-"));
	cleanupDirs.push(dir);
	process.env[ENV_AGENT_DIR] = dir;
	return dir;
}

function writeModelsJson(dir: string): void {
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				tokenharbor: {
					name: "tokenharbor",
					baseUrl: "https://tokenharbor.ai/v1",
					api: CUSTOM_PROVIDER_API,
					models: [
						{ id: "deepseek-v4", name: "DeepSeek V4", input: ["text"], reasoning: false },
					],
					modelOverrides: { "deepseek-v4": { contextWindow: 200_000 } },
				},
				localhost: {
					name: "localhost",
					baseUrl: "http://localhost:9000/v1",
					api: CUSTOM_PROVIDER_API,
					models: [],
				},
			},
		}),
	);
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ tokenharbor: { type: "api_key", key: "sk-old" } }),
	);
}

function createThis(refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }))) {
	return {
		session: { modelRuntime: { refresh } },
		showError: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showEditProviderDialog: vi.fn(),
		updateAvailableProviderCount: vi.fn(),
		refreshModelIndicators: vi.fn(),
		footer: { invalidate: vi.fn() },
		showSelector: vi.fn(),
		_refresh: refresh,
	};
}

function readJson(dir: string, file: string): any {
	return JSON.parse(readFileSync(join(dir, file), "utf-8"));
}

describe("editing a configured provider", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		for (const dir of cleanupDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
	});

	it("repoints the provider and replaces the key without touching its models", async () => {
		const dir = createAgentDir();
		writeModelsJson(dir);
		const fakeThis = createThis();

		await saveProviderEndpoint.call(fakeThis, "tokenharbor", {
			baseUrl: "https://proxy.example.com/v1/",
			apiKey: "sk-new",
		});

		const models = readJson(dir, "models.json");
		expect(models.providers.tokenharbor.baseUrl).toBe("https://proxy.example.com/v1");
		expect(models.providers.tokenharbor.models).toHaveLength(1);
		expect(models.providers.tokenharbor.modelOverrides["deepseek-v4"].contextWindow).toBe(
			200_000,
		);
		expect(models.providers.localhost.baseUrl).toBe("http://localhost:9000/v1");
		expect(readJson(dir, "auth.json").tokenharbor.key).toBe("sk-new");

		// Live.
		expect(fakeThis._refresh).toHaveBeenCalledWith({
			allowNetwork: false,
			providers: ["tokenharbor"],
		});
		expect(fakeThis.showError).not.toHaveBeenCalled();
		expect(fakeThis.footer.invalidate).toHaveBeenCalled();
	});

	it("keeps the stored key when the key field is left blank", async () => {
		const dir = createAgentDir();
		writeModelsJson(dir);
		const fakeThis = createThis();

		await saveProviderEndpoint.call(fakeThis, "tokenharbor", {
			baseUrl: "https://proxy.example.com/v1",
			apiKey: "",
		});

		expect(readJson(dir, "auth.json").tokenharbor.key).toBe("sk-old");
		expect(readJson(dir, "models.json").providers.tokenharbor.baseUrl).toBe(
			"https://proxy.example.com/v1",
		);
	});

	it("refuses an empty base URL and reopens the dialog instead of writing", async () => {
		const dir = createAgentDir();
		writeModelsJson(dir);
		const fakeThis = createThis();

		await saveProviderEndpoint.call(fakeThis, "tokenharbor", {
			baseUrl: "   ",
			apiKey: "sk-new",
		});

		expect(fakeThis.showError).toHaveBeenCalled();
		expect(fakeThis.showEditProviderDialog).toHaveBeenCalledWith("tokenharbor");
		expect(readJson(dir, "models.json").providers.tokenharbor.baseUrl).toBe(
			"https://tokenharbor.ai/v1",
		);
		expect(readJson(dir, "auth.json").tokenharbor.key).toBe("sk-old");
	});
});

describe("listing providers to edit", () => {
	it("offers only configured providers, sorted, with their base URLs", () => {
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => [
						{ id: "tokenharbor", baseUrl: "https://tokenharbor.ai/v1" },
						{ id: "unconfigured", baseUrl: "https://nope.example.com/v1" },
						{ id: "localhost", baseUrl: "http://localhost:9000/v1" },
					],
					getProviderAuthStatus: (id: string) =>
						id === "unconfigured"
							? { configured: false }
							: { configured: true, source: "stored" },
				},
			},
		};

		expect(configuredProviders.call(fakeThis)).toEqual([
			{ id: "localhost", baseUrl: "http://localhost:9000/v1", authLabel: "stored" },
			{ id: "tokenharbor", baseUrl: "https://tokenharbor.ai/v1", authLabel: "stored" },
		]);
	});
});
