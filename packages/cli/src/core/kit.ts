import { join } from "node:path";
import {
	Runner,
	type AgentMessage,
	type StreamFn,
	setDefaultStreamFn,
	type ThinkingLevel,
} from "@huranth/gama-agent-core";
import { getCurrentTools, type ModelsSimpleStreamOptions } from "@huranth/gama-ai";
import {
	clampThinkingLevel,
	type Message,
	type Model,
	streamSimple,
} from "@huranth/gama-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { RunSession } from "./session/session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import {
	fingerprintPrompt,
	priorPromptCacheOf,
	withPromptCacheStamping,
} from "./cache/prompt-hash.ts";
import { CacheWarmer } from "./cache/warmer.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type {
	PluginHost,
	LoadExtensionsResult,
	SessionStartEvent,
	ToolDefinition,
} from "./ext/index.ts";
import {
	createHandsTool,
	HAND_KINDS,
	HAND_SYSTEM_PROMPT,
	HANDS_TOOL_NAME,
	type HandsEvent,
} from "./hands.ts";
import { convertToLlm } from "./msg.ts";
import { findInitialModel } from "./pick.ts";
import { ModelHub } from "./model-run.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionStore } from "./sessions.ts";
import { DEFAULT_TOOL_NAMES, SettingsStore } from "./settings.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWebFetchTool,
	createWriteTool,
	withFileMutationQueue,
} from "./tools/index.ts";
import { getBranchSelection } from "./fake-models.ts";

export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./ext/index.ts";

export type { PromptTemplate } from "./prompt-templates.ts";

export type { Skill } from "./skills.ts";

export type { Tool } from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	cwd?: string;
	agentDir?: string;

	modelRuntime?: ModelHub;

	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	noTools?: "all" | "builtin";
	tools?: string[];
	excludeTools?: string[];
	customTools?: ToolDefinition[];
	enableHands?: boolean;
	appendSystemPrompt?: string;

	resourceLoader?: ResourceLoader;

	sessionManager?: SessionStore;

	settingsManager?: SettingsStore;
	sessionStartEvent?: SessionStartEvent;
}

export interface CreateAgentSessionResult {
	session: RunSession;
	extensionsResult: LoadExtensionsResult;
	modelFallbackMessage?: string;
}

setDefaultStreamFn(streamSimple);

export * from "./session/runtime.ts";

export {
	withFileMutationQueue,
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createWebFetchTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

type SessionView = ReturnType<SessionStore["buildSessionContext"]>;

type RunnerRef = { current?: PluginHost };

const DISABLED_IMAGE_TEXT = "Image reading is disabled.";

const MAX_IDLE_TIMEOUT_MS = 2_147_483_647;

function withFallbackMessage(
	previous: string | undefined,
	next: string | undefined,
): string | undefined {
	if (!previous) return next;
	return next ? `${previous} ${next}` : previous;
}

function createConvertToLlm(
	settingsManager: SettingsStore,
): (messages: AgentMessage[]) => Message[] {
	return (messages) => {
		const converted = convertToLlm(messages);
		if (!settingsManager.getBlockImages()) return converted;
		return converted.map((message) => withoutImages(message));
	};
}

function createRunner(input: {
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel;
	messages: AgentMessage[];
	sessionId: string;
	settingsManager: SettingsStore;
	runnerRef: RunnerRef;
	streamFn: StreamFn;
}): Runner {
	const { model, thinkingLevel, messages, sessionId, settingsManager, runnerRef } = input;
	const hooks = createProviderHooks(runnerRef);

	return new Runner({
		initialState: { systemPrompt: "", model, thinkingLevel, tools: [], messages },
		convertToLlm: createConvertToLlm(settingsManager),
		streamFn: input.streamFn,
		onPayload: hooks.onPayload,
		onResponse: hooks.onResponse,
		onProviderStreamEvent: hooks.onProviderStreamEvent,
		sessionId,
		transformContext: async (contextMessages) => {
			const runner = runnerRef.current;
			if (!runner) return contextMessages;
			return runner.emitContext(contextMessages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		coalesceQueuedMessages: true,
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});
}

function cacheContextIsCurrent(source: Runner, requestModel: Model<any>): () => boolean {
	const messages = source.state.messages.slice();
	return () => {
		const model = source.state.model;
		const current = source.state.messages;
		return (
			model.provider === requestModel.provider &&
			model.id === requestModel.id &&
			messages.length <= current.length &&
			messages.every((message, index) => current[index] === message)
		);
	};
}

function createProviderHooks(runnerRef: RunnerRef) {
	const onPayload = async (payload: unknown) => {
		const runner = runnerRef.current;
		if (!runner?.hasHandlers("before_provider_request")) return payload;

		return runner.emitBeforeProviderRequest(payload);
	};

	const onResponse: NonNullable<ModelsSimpleStreamOptions["onResponse"]> = async (response) => {
		const runner = runnerRef.current;
		if (!runner?.hasHandlers("after_provider_response")) return;

		await runner.emit({
			type: "after_provider_response",
			status: response.status,
			headers: response.headers,
		});
	};

	const onProviderStreamEvent: NonNullable<
		ModelsSimpleStreamOptions["onProviderStreamEvent"]
	> = async (data, model) => {
		const runner = runnerRef.current;
		if (!runner?.hasHandlers("provider_stream_event")) return;

		await runner.emit({
			data,
			type: "provider_stream_event",
			provider: model.provider,
			api: model.api,
			model: model.id,
		});
	};

	return { onPayload, onResponse, onProviderStreamEvent };
}

function buildRequestOptions(
	settingsManager: SettingsStore,
	runnerRef: RunnerRef,
	requestModel: Model<any>,
	options: ModelsSimpleStreamOptions = {},
): ModelsSimpleStreamOptions {
	const retry = settingsManager.getProviderRetrySettings();
	const idleTimeout = settingsManager.getHttpIdleTimeoutMs();
	const defaultTimeout = idleTimeout === 0 ? MAX_IDLE_TIMEOUT_MS : idleTimeout;
	const timeoutMs = options.timeoutMs ?? retry.timeoutMs ?? defaultTimeout;

	return {
		...options,
		timeoutMs,
		cacheRetention: options.cacheRetention ?? settingsManager.getCacheRetention(),
		websocketConnectTimeoutMs:
			options.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
		maxRetries: options.maxRetries ?? retry.maxRetries,
		maxRetryDelayMs: options.maxRetryDelayMs ?? retry.maxRetryDelayMs,
		transformHeaders: async (requestHeaders) => {
			const runner = runnerRef.current;
			const headers = mergeProviderAttributionHeaders(
				requestModel,
				settingsManager,
				requestHeaders,
			);

			if (!runner?.hasHandlers("before_provider_headers")) return headers ?? {};

			return runner.emitBeforeProviderHeaders(headers ?? {});
		},
	};
}

interface ToolLoadout {
	active: string[];
	allowed: string[] | undefined;
	excluded: string[] | undefined;
	recorded: string[] | undefined;
}

function resolveToolLoadout(
	options: CreateAgentSessionOptions,
	settingsManager: SettingsStore,
	existingSession: SessionView,
): ToolLoadout {
	const hasExistingSession = existingSession.messages.length > 0;
	const declaredTools = existingSession.messages.some(
		(message) =>
			message.role === "system" &&
			((message.toolsAdded?.length ?? 0) > 0 || (message.toolsRemoved?.length ?? 0) > 0),
	);

	const canRestore = hasExistingSession && declaredTools;
	const isRestoring = canRestore && options.tools === undefined && options.noTools === undefined;
	const recorded = isRestoring
		? getCurrentTools(existingSession.messages).map((tool) => tool.name)
		: undefined;

	const allowed = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excluded = options.excludeTools;
	const excludedSet = excluded ? new Set(excluded) : undefined;

	const requested =
		options.tools ??
		(options.noTools
			? []
			: (recorded ?? settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES));

	return {
		active: requested.filter((name) => !excludedSet?.has(name)),
		allowed,
		excluded,
		recorded,
	};
}

function withoutImages(message: Message): Message {
	if (message.role !== "user" && message.role !== "toolResult") return message;
	if (!Array.isArray(message.content)) return message;
	if (!message.content.some((block) => block.type === "image")) return message;

	const blocks = message.content.map((block) =>
		block.type === "image" ? { type: "text" as const, text: DISABLED_IMAGE_TEXT } : block,
	);
	const deduped = blocks.filter((block, index) => {
		if (block.type !== "text" || block.text !== DISABLED_IMAGE_TEXT) return true;

		const previous = blocks[index - 1];

		return !(previous?.type === "text" && previous.text === DISABLED_IMAGE_TEXT);
	});

	return { ...message, content: deduped };
}

function resolveThinkingLevel(
	options: CreateAgentSessionOptions,
	settingsManager: SettingsStore,
	model: Model<any> | undefined,
	existingSession: SessionView,
	hasThinkingEntry: boolean,
): ThinkingLevel {
	let level = options.thinkingLevel;
	const hasExistingSession = existingSession.messages.length > 0;

	if (level === undefined && hasExistingSession) {
		level = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	if (level === undefined && model) {
		level = settingsManager.getModelThinkingLevel(model.provider, model.id);
	}

	if (level === undefined) {
		level = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	if (!model) return "off";

	return clampThinkingLevel(model, level) as ThinkingLevel;
}

export async function createAgentSession(
	options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime =
		options.modelRuntime ?? (await ModelHub.create({ authPath, modelsPath }));
	const settingsManager = options.settingsManager ?? SettingsStore.create(cwd, agentDir);
	const sessionManager =
		options.sessionManager ?? SessionStore.create(cwd, getDefaultSessionDir(cwd, agentDir));

	let resourceLoader = options.resourceLoader;
	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager
		.getBranch()
		.some((entry) => entry.type === "thinking_level_change");

	const resolved = await resolveModel(
		options,
		modelRuntime,
		settingsManager,
		sessionManager,
		existingSession,
	);
	const model = resolved.model;
	const modelFallbackMessage = resolved.fallbackMessage;

	const thinkingLevel = resolveThinkingLevel(
		options,
		settingsManager,
		model,
		existingSession,
		hasThinkingEntry,
	);
	const loadout = resolveToolLoadout(options, settingsManager, existingSession);
	const runnerRef: RunnerRef = {};
	const cacheWarmer = new CacheWarmer(
		modelRuntime,
		sessionManager,
		() => settingsManager.getCacheWarmingMode(),
		() => ({
			assumedTtlMs: settingsManager.getCacheTtlMs(),
			savingsRatio: settingsManager.getCacheWarmSavingsRatio(),
		}),
	);

	const agent = createRunner({
		model,
		thinkingLevel,
		messages: existingSession.messages,
		sessionId: sessionManager.getSessionId(),
		settingsManager,
		runnerRef,
		streamFn: async (requestModel, context, requestOptions) => {
			const built = buildRequestOptions(
				settingsManager,
				runnerRef,
				requestModel,
				requestOptions,
			);
			if (requestOptions?.sessionId === sessionManager.getSessionId()) {
				cacheWarmer.start(
					{ model: requestModel, context, options: built },
					cacheContextIsCurrent(agent, requestModel),
				);
			}
			return withPromptCacheStamping(
				modelRuntime.streamSimple(requestModel, context, built),
				fingerprintPrompt({
					messages: context.messages,
					prior: priorPromptCacheOf(sessionManager.getBranch()),
				}),
				requestModel,
			);
		},
	});

	if (hasExistingSession) {
		if (!hasThinkingEntry) sessionManager.appendThinkingLevelChange(thinkingLevel);
	} else {
		if (model) sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	let publishHandsEvent: (event: HandsEvent) => void = () => {};
	let wakeParent: (text: string, handId: string) => void = () => {};
	let cancelWakeParent: (handId: string) => boolean = () => false;
	let parentSession: RunSession | undefined;
	const handsTool =
		options.enableHands !== true
			? undefined
			: createHandsTool({
					emit: (event) => publishHandsEvent(event),
					wake: (text, handId) => wakeParent(text, handId),
					cancelWake: (handId) => cancelWakeParent(handId),
					recordUsage: (provider, model, usage) => {
						sessionManager.appendUsage("hands", provider, model, usage);
					},
					createSession: async (_index, kind) => {
						const hand = HAND_KINDS[kind];
						const handModel = parentSession?.model ?? model;
						const handThinkingLevel = parentSession?.thinkingLevel ?? thinkingLevel;
						const created = await createAgentSession({
							cwd,
							agentDir: options.agentDir,
							modelRuntime,
							settingsManager,
							resourceLoader,
							model: handModel,
							thinkingLevel: handThinkingLevel,
							sessionManager: SessionStore.inMemory(cwd),
							tools: hand.tools ? [...hand.tools] : undefined,
							excludeTools: [
								...new Set([...(options.excludeTools ?? []), HANDS_TOOL_NAME]),
							],
							appendSystemPrompt: `${HAND_SYSTEM_PROMPT}\n\n${hand.prompt}`,
							enableHands: false,
						});
						return created.session;
					},
				});
	const customTools: ToolDefinition[] = [
		...(options.customTools ?? []).filter((tool) => tool.name !== HANDS_TOOL_NAME),
		...(handsTool ? [handsTool as unknown as ToolDefinition] : []),
	];

	const session = new RunSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		appendSystemPrompt: options.appendSystemPrompt,
		customTools,
		modelRuntime,
		cacheWarmer,
		initialActiveToolNames: loadout.active,
		includeAllExtensionToolsOnStart: loadout.recorded === undefined,
		usesDefaultTools: options.tools === undefined && !options.noTools,
		allowedToolNames: loadout.allowed,
		excludedToolNames: loadout.excluded,
		extensionRunnerRef: runnerRef,
		sessionStartEvent: options.sessionStartEvent,		});
	parentSession = session;
	publishHandsEvent = (event) => session.publishHandsEvent(event);
	let wakeQueue: Promise<void> = Promise.resolve();
	const canceledWakes = new Set<string>();
	const scheduledWakes = new Set<string>();
	wakeParent = (text, handId) => {
		if (canceledWakes.has(handId)) return;
		scheduledWakes.add(handId);
		wakeQueue = wakeQueue
			.then(async () => {
				if (canceledWakes.has(handId)) return;
				scheduledWakes.delete(handId);
				try {
					await session.sendCustomMessage(
						{
							customType: "hands",
							content: [{ type: "text", text }],
							display: true,
							details: { handId },
						},
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				} catch {}
			})
			.catch(() => undefined)
			.finally(() => {
				scheduledWakes.delete(handId);
			});
	};
	cancelWakeParent = (handId) => {
		const wasScheduled = scheduledWakes.has(handId);
		canceledWakes.add(handId);
		const removed = session.removeCustomMessages(
			(message) =>
				message.customType === "hands" &&
				(message.details as { handId?: unknown } | undefined)?.handId === handId,
		);
		return wasScheduled || removed > 0;
	};

	const extensionsResult = resourceLoader.getExtensions();

	return { session, extensionsResult, modelFallbackMessage };
}

async function resolveModel(
	options: CreateAgentSessionOptions,
	modelRuntime: ModelHub,
	settingsManager: SettingsStore,
	sessionManager: SessionStore,
	existingSession: SessionView,
): Promise<{ model: Model<any> | undefined; fallbackMessage: string | undefined }> {
	let model = options.model;
	let fallbackMessage: string | undefined;
	const hasExistingSession = existingSession.messages.length > 0;
	const sessionModel = getBranchSelection(sessionManager.getBranch(), (provider, modelId) =>
		modelRuntime.getModel(provider, modelId),
	);

	if (!model && hasExistingSession && sessionModel) {
		const restored = modelRuntime.getModel(sessionModel.provider, sessionModel.modelId);
		const canRestore = restored && modelRuntime.hasConfiguredAuth(restored.provider);
		if (canRestore) model = restored;

		if (!model) {
			fallbackMessage = `Could not restore model ${sessionModel.provider}/${sessionModel.modelId}`;
		}
	}

	if (model) return { model, fallbackMessage };

	const result = await findInitialModel({
		scopedModels: [],
		isContinuing: hasExistingSession,
		defaultProvider: settingsManager.getDefaultProvider(),
		defaultModelId: settingsManager.getDefaultModel(),
		defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
		modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
		modelRuntime,
	});
	model = result.model;

	if (result.fallbackMessage) {
		fallbackMessage = withFallbackMessage(fallbackMessage, result.fallbackMessage);
	}

	if (!model) {
		return { model, fallbackMessage: fallbackMessage ?? formatNoModelsAvailableMessage() };
	}

	if (fallbackMessage && !result.fallbackMessage) {
		fallbackMessage += `. Using ${model.provider}/${model.id}`;
	}

	return { model, fallbackMessage };
}
