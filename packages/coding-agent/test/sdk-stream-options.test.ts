import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	getCurrentTools,
	getSystemMessageText,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@huranth/gama-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/ext/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "gama-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, promptTokens = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api, promptTokens = 0) {
		const stream = createAssistantMessageEventStream();
		stream.end(createDoneMessage(api, promptTokens));
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionFactory?: ExtensionFactory,
		providerEvent?: unknown,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: extensionFactory ? [extensionFactory] : [],
		});
		await resourceLoader.reload();

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({
			type: "api_key",
			key: "test-api-key",
		}));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (requestModel, _context, providerOptions) => {
				capturedOptions = providerOptions;
				if (providerEvent === undefined) return createDoneStream(api);

				const stream = createAssistantMessageEventStream();
				void (async () => {
					await providerOptions?.onProviderStreamEvent?.(providerEvent, requestModel);
					stream.end(createDoneMessage(api));
				})();
				return stream;
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		try {
			if (providerEvent === undefined) {
				const stream = await session.agent.streamFunction(
					model,
					normalizeContext({ messages: [] }),
					requestOptions,
				);
				await stream.result();
			} else {
				await session.prompt("test");
			}
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", {
			httpIdleTimeoutMs: 1234,
		});

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", {
			websocketConnectTimeoutMs: 1234,
		});

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	it("forwards provider stream events to extensions", async () => {
		const providerEvent = { openrouter_metadata: { strategy: "direct" } };
		const extensionEvents: unknown[] = [];

		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{},
			(gama) => {
				gama.on("provider_stream_event", (event) => {
					extensionEvents.push(event);
				});
			},
			providerEvent,
		);

		expect(options?.onProviderStreamEvent).toEqual(expect.any(Function));
		expect(extensionEvents).toEqual([
			{
				data: providerEvent,
				type: "provider_stream_event",
				provider: "capture-provider",
				api: "openai-completions",
				model: "capture-model",
			},
		]);
	});

	it(
		"runs before_provider_headers on assembled headers without " + "forwarding the transform",
		async () => {
			const options = await captureStreamOptions(
				"openai-completions",
				{},
				{ headers: { "x-explicit": "explicit" } },
				(gama) => {
					gama.on("before_provider_headers", (event) => {
						event.headers["x-hook"] = [
							event.headers["x-provider"],
							event.headers["x-model"],
							event.headers["x-explicit"],
						].join(":");
					});
				},
			);

			expect(options?.headers).toMatchObject({
				"x-provider": "provider",
				"x-model": "model",
				"x-explicit": "explicit",
				"x-hook": "provider:model:explicit",
			});
			expect(options).not.toHaveProperty("transformHeaders");
		},
	);

	it(
		"restores the recorded tool loadout on resume without " + "reactivating extension defaults",
		async () => {
			const model = createModel("openai-completions");
			const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "bash"] });
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			await authStorage.modify(model.provider, async () => ({
				type: "api_key",
				key: "test-api-key",
			}));
			const modelRegistry = await createModelRegistry(
				authStorage,
				join(agentDir, "models.json"),
			);
			const requestedTools: string[][] = [];
			const requestedSystemPrompts: string[] = [];
			modelRegistry.registerProvider(model.provider, {
				api: model.api,
				streamSimple: (requestModel, context) => {
					requestedTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
					const system = getCurrentSystemMessage(context.messages);
					requestedSystemPrompts.push(system ? getSystemMessageText(system) : "");
					return createDoneStream(requestModel.api);
				},
			});
			const extensionFactory: ExtensionFactory = (gama) => {
				gama.registerTool({
					name: "extension_tool",
					label: "Extension tool",
					description: "Active by default",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			};
			const loadResources = async () => {
				const loader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
					extensionFactories: [extensionFactory],
				});
				await loader.reload();
				return loader;
			};
			const sessionManager = SessionManager.create(cwd, join(tempDir, "sessions"));
			const baseOptions = {
				cwd,
				agentDir,
				model,
				modelRuntime: getModelRuntime(modelRegistry),
				settingsManager,
			};

			try {
				const { session } = await createAgentSession({
					...baseOptions,
					sessionManager,
					resourceLoader: await loadResources(),
				});
				try {
					await session.prompt("first");
					expect(session.getActiveToolNames()).toEqual(["read", "bash", "extension_tool"]);
					session.setActiveToolsByName(["read"]);
					await session.prompt("second");
					expect(requestedTools.at(-1)).toEqual(["read"]);
				} finally {
					session.dispose();
				}

				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected a saved session");
				const resumedManager = SessionManager.open(sessionFile);
				const { session: resumed } = await createAgentSession({
					...baseOptions,
					sessionManager: resumedManager,
					resourceLoader: await loadResources(),
				});
				try {
					expect(resumed.getActiveToolNames()).toEqual(["read"]);
					await resumed.prompt("third");
					expect(requestedTools.at(-1)).toEqual(["read"]);
					expect(requestedSystemPrompts.at(-1)).toBe(requestedSystemPrompts.at(-2));
					resumed.setActiveToolsByName([]);
					await resumed.prompt("fourth");
					expect(requestedTools.at(-1)).toEqual([]);
				} finally {
					resumed.dispose();
				}

				const { session: empty } = await createAgentSession({
					...baseOptions,
					sessionManager: SessionManager.open(sessionFile),
					resourceLoader: await loadResources(),
				});
				try {
					expect(empty.getActiveToolNames()).toEqual([]);
				} finally {
					empty.dispose();
				}

				const { session: overridden } = await createAgentSession({
					...baseOptions,
					sessionManager: SessionManager.open(sessionFile),
					resourceLoader: await loadResources(),
					tools: ["bash"],
				});
				try {
					expect(overridden.getActiveToolNames()).toEqual(["bash"]);
				} finally {
					overridden.dispose();
				}

				const { session: extensionOnly } = await createAgentSession({
					...baseOptions,
					sessionManager: SessionManager.open(sessionFile),
					resourceLoader: await loadResources(),
					noTools: "builtin",
				});
				try {
					expect(extensionOnly.getActiveToolNames()).toEqual(["extension_tool"]);
				} finally {
					extensionOnly.dispose();
				}
			} finally {
				modelRegistry.unregisterProvider(model.provider);
			}
		},
	);
});
