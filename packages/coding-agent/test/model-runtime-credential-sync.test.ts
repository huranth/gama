import type { Model, Provider } from "@huranth/gama-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

function model(provider: string): Model<"openai-completions"> {
	return {
		id: "dynamic",
		name: "Dynamic",
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function provider(
	id: string,
	options: {
		refreshModels?: Provider["refreshModels"];
	} = {},
): Provider<"openai-completions"> {
	const providerModel = model(id);
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				check: async ({ credential }) =>
					credential ? { type: "api_key", source: "stored" } : undefined,
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [providerModel],
		refreshModels: options.refreshModels,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

async function runtimeWithProvider(
	registered: Provider,
	credentials: AuthStorage = AuthStorage.inMemory(),
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(registered);
	await runtime.refresh({ allowNetwork: false, providers: [registered.id] });
	return runtime;
}

describe("ModelRuntime credential synchronization", () => {
	it("publishes locally consistent availability when a runtime API key is set and removed", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(provider("dynamic"), credentials);

		await runtime.setRuntimeApiKey("dynamic", "dynamic-key");
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);
		expect(runtime.getAvailableSnapshot().map((entry) => entry.id)).toContain("dynamic");
		expect(await credentials.read("dynamic")).toBeUndefined();

		await runtime.removeRuntimeApiKey("dynamic");
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === "dynamic")).toBe(
			false,
		);
		expect(await credentials.read("dynamic")).toBeUndefined();
	});

	it("allows different providers to run credential flows concurrently", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
		});
		runtime.registerNativeProvider(provider("one"));
		runtime.registerNativeProvider(provider("two"));
		await runtime.refresh({ allowNetwork: false, providers: ["one", "two"] });

		await Promise.all([
			runtime.setRuntimeApiKey("one", "one-key"),
			runtime.setRuntimeApiKey("two", "two-key"),
		]);
		expect(runtime.hasConfiguredAuth("one")).toBe(true);
		expect(runtime.hasConfiguredAuth("two")).toBe(true);
	});

	it("does not wait for unrelated provider availability during local synchronization", async () => {
		let stallUnrelated = false;
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
		});
		runtime.registerNativeProvider(provider("target"));
		const unrelated = provider("unrelated");
		if (unrelated.auth.apiKey) {
			unrelated.auth.apiKey.check = async () => {
				if (stallUnrelated) await new Promise<void>(() => {});
				return undefined;
			};
		}
		runtime.registerNativeProvider(unrelated);
		await runtime.refresh({ allowNetwork: false, providers: ["target", "unrelated"] });
		stallUnrelated = true;

		await runtime.setRuntimeApiKey("target", "target-key");
		expect(runtime.hasConfiguredAuth("target")).toBe(true);
		await expect(
			runtime.refresh({ allowNetwork: false, providers: ["target"] }),
		).resolves.toMatchObject({
			aborted: false,
		});
	});

	it("reports cancellation that occurs during provider-scoped availability", async () => {
		let blockAvailability = false;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const registered = provider("cancelled-availability");
		if (registered.auth.apiKey) {
			registered.auth.apiKey.check = async ({ credential }) => {
				if (blockAvailability) {
					markStarted?.();
					await new Promise<void>(() => {});
				}
				return credential ? { type: "api_key", source: "stored" } : undefined;
			};
		}
		const runtime = await runtimeWithProvider(registered);
		await runtime.setRuntimeApiKey(registered.id, "key");
		blockAvailability = true;
		const controller = new AbortController();
		const refresh = runtime.refresh({
			allowNetwork: false,
			providers: [registered.id],
			signal: controller.signal,
		});
		await started;
		controller.abort();

		await expect(refresh).resolves.toMatchObject({ aborted: true });
	});

	it("does not run network refresh inside the credential operation chain", async () => {
		const networkRefresh = vi.fn(async () => new Promise<void>(() => {}));
		const runtime = await runtimeWithProvider(
			provider("local-only", {
				refreshModels: async (context) => {
					if (context.allowNetwork) await networkRefresh();
				},
			}),
		);

		await runtime.setRuntimeApiKey("local-only", "local-only-key");
		expect(networkRefresh).not.toHaveBeenCalled();
		expect(runtime.hasConfiguredAuth("local-only")).toBe(true);
	});

	it("keeps provider-scoped refreshes from superseding unrelated providers", async () => {
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		let firstSignal: AbortSignal | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
		});
		runtime.registerNativeProvider(
			provider("one", {
				refreshModels: async (context) => {
					if (!context.allowNetwork) return;
					firstSignal = context.signal;
					markStarted?.();
					await blocked;
				},
			}),
		);
		runtime.registerNativeProvider(provider("two"));
		await runtime.refresh({ allowNetwork: false, providers: ["one", "two"] });
		await runtime.setRuntimeApiKey("one", "one-key");
		await runtime.setRuntimeApiKey("two", "two-key");

		const first = runtime.refresh({ allowNetwork: true, providers: ["one"] });
		await started;
		await runtime.refresh({ allowNetwork: true, providers: ["two"] });
		expect(firstSignal?.aborted).toBe(false);

		finish?.();
		await first;
	});

	it("reports a typed error when cancellation interrupts post-commit synchronization", async () => {
		let blockCacheRefresh = false;
		let markCacheRefreshStarted: (() => void) | undefined;
		const cacheRefreshStarted = new Promise<void>((resolve) => {
			markCacheRefreshStarted = resolve;
		});
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("cancelled-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && blockCacheRefresh) {
						markCacheRefreshStarted?.();
						await new Promise<void>(() => {});
					}
				},
			}),
			credentials,
		);
		blockCacheRefresh = true;
		const controller = new AbortController();
		const setKey = runtime.setRuntimeApiKey("cancelled-sync", "cancelled-sync-key", {
			signal: controller.signal,
		});
		await cacheRefreshStarted;
		controller.abort();

		await expect(setKey).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "cancelled-sync",
			operation: "setRuntimeApiKey",
			credential: { type: "api_key", key: "cancelled-sync-key" },
		});
		expect(runtime.getProviderAuthStatus("cancelled-sync")).toEqual({
			configured: true,
			source: "runtime",
		});
		expect(await credentials.read("cancelled-sync")).toBeUndefined();
	});

	it("reports committed credentials when local synchronization fails", async () => {
		let failCacheRefresh = false;
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("broken-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && failCacheRefresh)
						throw new Error("cache restore failed");
				},
			}),
			credentials,
		);
		failCacheRefresh = true;

		const setKey = runtime.setRuntimeApiKey("broken-sync", "broken-sync-key");
		await expect(setKey).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "broken-sync",
			operation: "setRuntimeApiKey",
			credential: { type: "api_key", key: "broken-sync-key" },
		});
		await expect(setKey).rejects.toBeInstanceOf(CredentialSynchronizationError);
		expect(runtime.getProviderAuthStatus("broken-sync")).toEqual({
			configured: true,
			source: "runtime",
		});
		expect(await credentials.read("broken-sync")).toBeUndefined();
	});
});
