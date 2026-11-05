import { basename, dirname } from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Runner,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type ThinkingLevel,
} from "@huranth/gama-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	normalizeContext,
	retryDelayMs,
} from "@huranth/gama-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@huranth/gama-ai/compat";
import {
	clampThinkingLevel,
	closeSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@huranth/gama-ai/compat";
import { getThemeByName, theme } from "../../term/theme/theme.ts";
import { sleep } from "../../utils/sleep.ts";
import { normalizeToolResultImages } from "../../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "../bash-executor.ts";
import { generateBugReportSummary } from "../bug-report.ts";
import {
	buildCacheSnapshot,
	type CacheHealth,
	type CacheSnapshot,
	type CacheWarmingStatus,
} from "../cache/index.ts";
import type { CacheWarmer } from "../cache/warmer.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	collectEntriesForBranchSummary,
	compact,
	completeSummarization,
	estimateProjectedContextTokens,
	generateBranchSummary,
	getSummarizationFailure,
	prepareCompaction,
	type SummarizationLineage,
	shouldCompact,
} from "../comp/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../defaults.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	PluginHost,
	type ExtensionUIContext,
	type InputSource,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExposure,
	type ToolInfo,
	type TreePreparation,
} from "../ext/index.ts";
import { emitSessionShutdownEvent } from "../ext/runner.ts";
import type { HandsEvent } from "../hands.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "../html/index.ts";
import { createToolHtmlRenderer } from "../html/tool-renderer.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "../msg.ts";
import { pickNextModel } from "../model-cycle.ts";
import { ModelRegistry } from "../roster.ts";
import type { ModelHub } from "../model-run.ts";
import { NestedToolCallRunner } from "../nested.ts";
import { expandPromptTemplate, type PromptTemplate } from "../prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "../resource-loader.ts";
import { applyBoundaryDrafts, createBoundaryPreviewManager } from "../session-boundary.ts";
import { exportSessionToJsonl } from "../dump.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type SessionStore,
	type SessionProjection,
} from "../sessions.ts";
import { computeContextUsage, computeSessionStats, type SessionStats } from "../session-stats.ts";
import {
	type CacheWarmingMode,
	DEFAULT_TOOL_NAMES,
	type SettingsStore,
} from "../settings.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import { isSyntheticPath } from "../origin.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "../system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "../tools/bash.ts";
import { createAllToolDefinitions, createFileReadTracker } from "../tools/index.ts";
import { createToolDefinitionFromAgentTool } from "../tools/tool-definition-wrapper.ts";
import { withBuiltInRenderers } from "../tools/ui/index.ts";
import { combineUsage } from "../usage.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "../fake-models.ts";
import {
	assertCompactionResult,
	autoCompactionErrorMessage,
	buildSummarizationLineage,
	checkCompaction,
	CompactionCancelled,
	isCompactionAborted,
	prepareManualCompaction,
} from "../session-runtime/compaction.ts";
import {
	type SessionEvent,
	type AgentSessionEventListener,
	emitExtensionEvent,
	emitSessionEvent,
	makeAgentEndEvent,
	makeQueueUpdateEvent,
	subscribeToSessionEvents,
} from "../session-runtime/events.ts";
import {
	expandSkillCommand,
	normalizePromptImages,
	parseCommand,
	parsePromptContent,
	runInputHandlers,
} from "../session-runtime/prompt.ts";
import {
	consumeQueuedMessage,
	countPendingMessages,
	queueFollowUpInput,
	queueSteeringInput,
	queueUserInput,
	type QueuedInputDisposition,
} from "../session-runtime/queue.ts";
import {
	applyToolLoadout,
	buildToolRegistry,
	getCallableTools,
	getToolExposure,
	isToolActivatedOnRegistration,
	isToolDeclarable,
	type ToolDefinitionEntry,
} from "../session-runtime/tools.ts";
import {
	buildCacheHealth,
	estimateMessagesTokens,
	FREE_COST,
	getLastAssistantText,
	recordPromptSummaryUsage,
} from "../session-runtime/usage.ts";

export type { SessionEvent, AgentSessionEventListener } from "../session-runtime/events.ts";
export type { ParsedSkillBlock } from "../session-runtime/prompt.ts";
export type { QueuedInputDisposition } from "../session-runtime/queue.ts";

// Optional warmer
type SessionCacheWarmer = Pick<
	CacheWarmer,
	"cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed"
>;

export interface AgentSessionConfig {
	agent: Runner;
	sessionManager: SessionStore;
	settingsManager: SettingsStore;
	cwd: string;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	resourceLoader: ResourceLoader;
	customTools?: ToolDefinition[];
	modelRuntime: ModelHub;
	cacheWarmer?: SessionCacheWarmer;
	initialActiveToolNames?: string[];
	includeAllExtensionToolsOnStart?: boolean;
	usesDefaultTools?: boolean;
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	baseToolsOverride?: Record<string, AgentTool>;
	extensionRunnerRef?: { current?: PluginHost };
	sessionStartEvent?: SessionStartEvent;
	appendSystemPrompt?: string;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type PromptDisposition = QueuedInputDisposition | "started";

export interface PromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	source?: InputSource;
	preflightResult?: (disposition: PromptDisposition) => void;
}

export interface ModelMutationOptions {
	persist?: boolean;
}

export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	isScoped: boolean;
}

export type { SessionStats } from "../session-stats.ts";
export { parseSkillBlock } from "../session-runtime/prompt.ts";

function withoutDeletedHeaders(
	headers: ProviderHeaders | undefined,
): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(
				Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
			)
		: undefined;
}

function activityOutcome(stopReason: AssistantMessage["stopReason"]): AgentActivityOutcome {
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "error";
	return "completed";
}

export class RunSession {
	readonly agent: Runner;
	readonly sessionManager: SessionStore;
	readonly settingsManager: SettingsStore;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Run state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _isPreparingPrompt = false;
	private _promptPreparationAbortRequested = false;
	private _agentRunAbortRequested = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	// Queues
	private _steeringMessages: string[] = [];
	private _followUpMessages: string[] = [];
	private _pendingNextTurnMessages: CustomMessage[] = [];
	private _pendingCustomMessages: CustomMessage[] = [];

	// Compaction
	private _compactionAbortController: AbortController | undefined;
	private _autoCompactionAbortController: AbortController | undefined;
	private _overflowRecoveryAttempted = false;

	private _branchSummaryAbortController: AbortController | undefined;

	// Retry
	private _retryAbortController: AbortController | undefined;
	private _retryAttempt = 0;
	private _failedResponse: AssistantMessage | undefined;

	// Bash
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension runner
	private _extensionRunner!: PluginHost;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantToolResults: AgentMessage[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	private _isDrainingSettledActions = false;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];

	// Resources
	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: PluginHost };
	private _initialActiveToolNames?: string[];
	private _pendingToolNames = new Set<string>();
	private _usesDefaultTools: boolean;
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private readonly _fileReadTracker = createFileReadTracker();
	private _cacheWarmer?: SessionCacheWarmer;
	private _appendSystemPrompt?: string;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	// Model
	private _modelRuntime: ModelHub;

	// Tools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Prompt
	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._cacheWarmer = config.cacheWarmer;

		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}

		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		this._allowedToolNames = config.allowedToolNames
			? new Set(config.allowedToolNames)
			: undefined;
		this._excludedToolNames = config.excludedToolNames
			? new Set(config.excludedToolNames)
			: undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._appendSystemPrompt = config.appendSystemPrompt;
		this._sessionStartEvent = config.sessionStartEvent ?? {
			type: "session_start",
			reason: "startup",
		};

		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentBoundaryHooks();
		this._installHiddenDeclarationsProjection();
		this._installAgentForcedPromptProjection();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: config.includeAllExtensionToolsOnStart ?? true,
		});
		if (this._initialActiveToolNames === undefined) this._restoreToolsFromTranscript();
	}

	get modelRuntime(): ModelHub {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;

		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const needsKey =
				cause instanceof Error && cause.message === "authHeader requires a resolved API key";
			if (needsKey) throw new Error(formatNoApiKeyFoundMessage(model.provider));

			throw error;
		}

		if (!result || (!result.auth.apiKey && !result.auth.headers)) {
			throw new Error(formatNoApiKeyFoundMessage(model.provider));
		}

		const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;

		return {
			model: requestModel,
			apiKey: result.auth.apiKey,
			headers: withoutDeletedHeaders(result.auth.headers),
			env: result.env,
		};
	}

	private async _getSummarizationRequestAuth(
		selectedModel: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		const resolved = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(this.messages), {
					reason: "direct",
					thinkingLevel: this.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: this.thinkingLevel };
		const { model, thinkingLevel } = resolved;

		if (this.agent.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };

			const requestModel = result.auth.baseUrl
				? { ...model, baseUrl: result.auth.baseUrl }
				: model;

			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;

			return { model, thinkingLevel };
		}
	}

	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (!model) return undefined;

		if (isVirtualModel(model)) {
			return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		}

		const isMatch = model.provider === message.provider && model.id === message.model;

		return isMatch ? model : undefined;
	}

	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;

		const getModel = (provider: string, modelId: string) =>
			this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		if (!recorded) return;

		const unchanged = recorded.provider === model.provider && recorded.modelId === model.id;
		if (unchanged) return;

		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
	}

	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context) => this._beforeToolCall(context);
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				...(parentToolCallId ? { parentToolCallId } : {}),
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed: ${String(err)}`);
		}
	}

	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined
						? {}
						: { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: {
							content: [{ type: "text", text: "No assistant message issued this call" }],
							details: {},
						},
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: (context) => this._beforeToolCall(context, parentId),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		if (model.contextWindow <= 0) return false;
		return shouldCompact(
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			model.contextWindow,
			this.settingsManager.getCompactionSettings(model),
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const projection = this.sessionManager.buildSessionProjection();
		const model = this.model;
		if (!model || isVirtualModel(model) || !this._exceedsCompactionThreshold(model, projection)) {
			return { ...context, messages: projection.messages };
		}
		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const prepare = async () => {
				const projection = this.sessionManager.buildSessionProjection();
				const canonicalContext = {
					...request.context,
					messages: projection.messages,
					tools: this.agent.state.tools.slice(),
				};
				const previous = await previousPrepareRequest?.(
					{
						...request,
						context: canonicalContext,
						model: this.agent.state.model,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					signal,
				);
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			let { previous, context, projection } = await prepare();
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			if (!isVirtualModel(model)) return { ...previous, context, model, thinkingLevel };

			const lastResponse = context.messages.findLastIndex(
				(message) => message.role === "assistant",
			);
			const userTurn = context.messages
				.slice(lastResponse + 1)
				.some((message) => message.role === "user");
			const state = getVirtualModelState(
				this.sessionManager.getBranch(),
				model.provider,
				model.id,
			);
			const route = await this._modelRuntime.resolveModel(
				model,
				convertToLlm(context.messages),
				{
					reason: failed ? "retry" : userTurn ? "user" : "continuation",
					thinkingLevel,
					signal,
					failed,
					state,
				},
			);
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = {
					provider: model.provider,
					modelId: model.id,
					state: route.state,
				};
				const entry = this.sessionManager.getEntry(
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			if (this._exceedsCompactionThreshold(route.model, projection)) {
				await this._runAutoCompaction("threshold", false);
				({ previous, context } = await prepare());
			}
			return {
				...previous,
				context,
				model: route.model,
				thinkingLevel: route.thinkingLevel,
			};
		};
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome = activityOutcome(message.stopReason);
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "Missing entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		this._commitBoundaryDrafts(boundary.entries);
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(
				turn.message,
				turn.toolResults,
			);
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (previousDecision?.action === "end") return previousDecision;
			if (extensionContinue || previousDecision?.action === "continue")
				return { action: "continue" };
			return undefined;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) =>
						await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(
				{ ...turn, context },
				signal,
			);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
				toolSnippets: {
					...this._baseSystemPromptOptions.toolSnippets,
					...runOptions.toolSnippets,
				},
				toolGuidelines: {
					...this._baseSystemPromptOptions.toolGuidelines,
					...runOptions.toolGuidelines,
				},
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages)
				this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const preview = createBoundaryPreviewManager(this.sessionManager, this._cwd, drafts);
		const projection = preview.buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		const finalRole = llmMessages[llmMessages.length - 1]?.role;
		const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
		const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
		const pendingCustomContext = this._pendingCustomMessages.length > 0;
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): void {
		const appended = applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) {
			this._emit({ type: "entry_appended", entry });
		}
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	private _emit(event: SessionEvent): void {
		emitSessionEvent(this._eventListeners, event);
	}

	private _emitQueueUpdate(): void {
		this._emit(makeQueueUpdateEvent(this._steeringMessages, this._followUpMessages));
	}

	private async _emitSessionCompactFailed(
		event: Omit<SessionCompactFailedEvent, "type">,
	): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (
			!this.isIdle ||
			this._isEmittingAgentSettled ||
			this._isDrainingSettledActions ||
			!this._resolveIdleWait
		) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		this._isEmittingAgentSettled = true;
		try {
			try {
				await this._extensionRunner.emit({ type: "agent_settled" });
				this._emit({ type: "agent_settled" });
			} finally {
				this._isEmittingAgentSettled = false;
			}
			const deferred = this._deferredSettledActions.splice(0);
			this._isDrainingSettledActions = deferred.length > 0;
			try {
				for (const action of deferred) {
					await action();
				}
			} finally {
				this._isDrainingSettledActions = false;
			}
		} finally {
			// Never strand
			this._resolveIdleWaitIfIdle();
		}
	}

	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage
						? combineUsage(message.usage, summary.usage)
						: summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const isSteering = event.message.steering === true;
			const isFollowUp = event.message.steering === false;
			// Direct prompt
			if (isSteering || isFollowUp) {
				const queue = isSteering ? this._steeringMessages : this._followUpMessages;
				const messageText = contentText(event.message.content, "");
				if (consumeQueuedMessage(queue, messageText) > 0) {
					this._emitQueueUpdate();
				}
			}
		}

		await this._emitExtensionEvent(event);
		this._emit(
			event.type === "agent_end"
				? makeAgentEndEvent(event, this._willRetryAfterAgentEnd(event))
				: event,
		);

		if (event.type === "message_end") {
			let entryId: string | undefined;
			if (event.message.role === "custom") {
				entryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "system" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				entryId = this.sessionManager.appendMessage(event.message);
			}
			if (entryId) this._entryIdsByMessage.set(event.message, entryId);

			if (event.message.role === "assistant") {
				const assistantMsg = event.message as AssistantMessage;
				this._lastAssistantMessage = assistantMsg;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		if (event.type === "turn_end") {
			this._lastAssistantToolResults = event.toolResults;
			this._flushPendingCustomMessages();
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		if (this._agentRunAbortRequested) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];

			if (message.role === "assistant") return this._isRetryableError(message as AssistantMessage);
		}

		return false;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;

		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;

		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;

		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex !== messageIndex) {
					projectedIndex++;
					continue;
				}

				this._entryIdsByMessage.set(message, entry.sourceEntry.id);

				return entry.sourceEntry.id;
			}
		}

		return undefined;
	}

	private _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): void {
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) =>
				targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);

		if (unresolvedProjectedTarget) {
			throw new Error("Missing source entry");
		}

		for (const targetId of targetIds) {
			if (!targetId) continue;

			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);

			if (entry) this._emit({ type: "entry_appended", entry });
		}

		this._refreshFinalizedContext();
	}

	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;

		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];

			if (message.role === "assistant") return message as AssistantMessage;
		}

		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		this._turnIndex = await emitExtensionEvent(
			{
				runner: this._extensionRunner,
				turnIndex: this._turnIndex,
				setTurnIndex: (turnIndex) => {
					this._turnIndex = turnIndex;
				},
				dispatchTurnEndBoundary: (message, toolResults) =>
					this._dispatchTurnEndBoundary(message, toolResults),
				clearBoundaryDispatched: (message) =>
					this._boundaryDispatchedMessages.delete(message),
				replaceMessageInPlace: (target, replacement) =>
					this._replaceMessageInPlace(target, replacement),
			},
			event,
		);
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		return subscribeToSessionEvents(this._eventListeners, listener);
	}

	publishHandsEvent(event: HandsEvent): void {
		this._emit(event);
	}

	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	dispose(): void {
		try {
			// Stop loop
			if (this._isAgentRunActive) this._agentRunAbortRequested = true;
			if (this._isPreparingPrompt) this._promptPreparationAbortRequested = true;
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. " +
				"Do not use a captured gama or command ctx after ctx.newSession(), ctx.fork(), " +
				"ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, " +
				"move post-replacement work into withSession and use the ctx passed to withSession. " +
				"For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		for (const { definition } of this._toolDefinitions.values()) {
			try {
				definition.dispose?.();
			} catch {}
		}
		this._eventListeners = [];
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			this._cacheWarmer.cancel();
		}
		const resolveIdleWait = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolveIdleWait?.();
		closeSessionResources(this.sessionId);
	}

	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}

	get state(): AgentState {
		return this.agent.state;
	}

	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	// Prompt summary
	async summarizePrompt(text: string, signal?: AbortSignal): Promise<string> {
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
		const request = await this._getSummarizationRequestAuth(model, signal);
		const context = normalizeContext({
			systemPrompt:
				"Summarize the user's prompt for a coding agent in one or two sentences. " +
				"Keep it under 40 words, state the concrete goal, and reply with the summary only.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				},
			],
		});
		const options: SimpleStreamOptions = {
			maxTokens: Math.min(
				300,
				request.model.maxTokens > 0 ? request.model.maxTokens : Number.POSITIVE_INFINITY,
			),
			signal,
			apiKey: request.apiKey,
			headers: request.headers,
			env: request.env,
		};
		if (request.model.reasoning && request.thinkingLevel !== "off") {
			options.reasoning = request.thinkingLevel;
		}
		const response = await completeSummarization(
			request.model,
			context,
			options,
			this.agent.streamFunction,
			this.settingsManager.getRetrySettings(),
		);
		if (response.stopReason === "aborted") {
			throw new Error(response.errorMessage || "Summary cancelled");
		}
		const failure = getSummarizationFailure(response, "Prompt summary");
		if (failure) throw new Error(failure);
		if (response.content.some((content) => content.type === "toolCall")) {
			throw new Error("Summary used tool");
		}
		const summary = contentText(response.content).trim();
		if (!summary) throw new Error("Summary empty");
		this._recordPromptSummaryUsage(response);
		return summary;
	}

	private _recordPromptSummaryUsage(response: AssistantMessage): void {
		recordPromptSummaryUsage(
			{
				isStreaming: this.isStreaming,
				isCompacting: this.isCompacting,
				waitForIdle: () => this.agent.waitForIdle(),
				appendUsage: (message) =>
					this.sessionManager.appendUsage(
						"prompt_summary",
						message.provider,
						message.responseModel ?? message.model,
						message.usage,
						"prompt summary",
					),
			},
			response,
		);
	}

	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	// Prep state
	get isPreparingPrompt(): boolean {
		return this._isPreparingPrompt;
	}

	get isIdle(): boolean {
		return !this._isAgentRunActive && !this._isPreparingPrompt && !this.isCompacting;
	}

	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	get retryAttempt(): number {
		return this._retryAttempt;
	}

	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	setActiveToolsByName(toolNames: string[]): void {
		const previous = this.getActiveToolNames();
		this._setActiveTools(toolNames);
		const active = new Set(this.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	private _setActiveTools(toolNames: string[]): void {
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) {
			this._pendingToolNames.delete(tool.name);
		}
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	private _isAllowedTool(name: string): boolean {
		return (
			(!this._allowedToolNames || this._allowedToolNames.has(name)) &&
			!this._excludedToolNames?.has(name)
		);
	}

	private _getToolExposure(name: string): ToolExposure {
		return getToolExposure(this._toolDefinitions, name);
	}

	private _getCallableTools(
		active: ReadonlySet<string> = new Set(this.getActiveToolNames()),
	): AgentTool[] {
		return getCallableTools(this._toolRegistry, this._toolDefinitions, active);
	}

	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const result = applyToolLoadout(
			{
				registry: this._toolRegistry,
				definitions: this._toolDefinitions,
				emitError: (error) => this._extensionRunner.emitError(error),
			},
			toolNames,
		);
		this._hiddenDeclarations = result.hidden;
		this.agent.state.tools = result.declared;
		return result.declared;
	}

	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	setScopedModels(
		scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>,
	): void {
		this._scopedModels = scopedModels;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet && !this._hiddenDeclarations.has(name)) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const appendParts = [...this._resourceLoader.getAppendSystemPrompt()];
		if (this._appendSystemPrompt) appendParts.push(this._appendSystemPrompt);
		const appendSystemPrompt = appendParts.join("\n\n");
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map(
			(tool) => tool.name,
		);
		options.toolSnippets = Object.fromEntries(
			Object.entries(options.toolSnippets).filter(
				([name]) => !this._hiddenDeclarations.has(name),
			),
		);
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections
			? { role: "system", content: "", sections, timestamp: Date.now() }
			: undefined;
	}

	private _installHiddenDeclarationsProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext
				? await previousTransformContext(messages, signal)
				: messages;
			const hidden = this._hiddenDeclarations;
			if (hidden.size === 0) return transformed;
			return transformed.map((message) => {
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved))
					return message;
				const { toolsAdded, toolsRemoved, ...rest } = message;
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				return {
					...rest,
					...(added.length > 0 ? { toolsAdded: added } : {}),
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext
				? await previousTransformContext(messages, signal)
				: messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	private _restoreToolsFromTranscript(): void {
		this._pendingToolNames.clear();
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = (current.toolsAdded ?? []).map((tool) => tool.name);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this._setActiveTools(names);
	}

	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._agentRunAbortRequested = false;
		this._failedResponse = undefined;
		// Clear stale
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		this._recordSelection();
		this._pendingToolNames.clear();
		this._isAgentRunActive = true;
		let flushError: unknown;
		try {
			await this.agent.prompt(messages);
			while (!this._agentRunAbortRequested) {
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested) break;
					await this.agent.continue();
					continue;
				}
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested) break;
				await this.agent.continue();
			}
		} finally {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = undefined;
			this._runSystemPromptOptions = undefined;
			// Flush guard
			try {
				this._flushPendingBashMessages();
				this._flushPendingCustomMessages();
			} catch (error) {
				flushError = error;
			}
			await this._emitAgentSettled();
		}
		if (flushError !== undefined) throw flushError;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = message;
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(message, true, toolResults)) {
			return !this._agentRunAbortRequested;
		}

		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle"))
			return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			this._commitBoundaryDrafts(result.entries);
			this._flushPendingCustomMessages();
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		return runInputHandlers(
			this._extensionRunner,
			text,
			images,
			source,
			streamingBehavior,
		);
	}

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => await this.prompt(text, options));
			return;
		}
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(text);
			if (handled) {
				preflightResult?.("handled");
				return;
			}
		}

		if (this.isCompacting) {
			throw new Error("Compaction running");
		}

		const processedInput = await this._runInputHandlers(
			text,
			options?.images,
			options?.source ?? "interactive",
			this.isStreaming ? options?.streamingBehavior : undefined,
		);
		if (!processedInput) {
			preflightResult?.("handled");
			return;
		}
		const { text: currentText, images: currentImages } = processedInput;

		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		if (this.isStreaming || this._isPreparingPrompt) {
			if (!options?.streamingBehavior) {
				throw new Error("Agent busy");
			}
			if (options.streamingBehavior === "followUp") {
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				await this._queueSteer(expandedText, currentImages);
			}
			preflightResult?.("queued");
			return;
		}

		// Claim run
		this._isPreparingPrompt = true;
		let messages: AgentMessage[];
		let preparationSucceeded = false;
		let preparationAborted = false;
		try {
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();

			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPromptOptions,
			);
			const handlerEditedTools =
				result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
				result.systemPromptOptions.selectedTools.some(
					(name, index) => name !== selectedToolsBefore[index],
				);
			if (!handlerEditedTools)
				result.systemPromptOptions.selectedTools = this.getActiveToolNames();

			const normalized = await normalizePromptImages(currentImages, {
				getAutoResizeImages: () => this.settingsManager.getImageAutoResize(),
				getResizeOptions: () => this._limitsModel()?.inputLimits?.images?.resize,
			});
			const userText =
				normalized.hints.length > 0
					? `${expandedText}\n\n${normalized.hints.join("\n")}`
					: expandedText;

			messages = [];
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: userText }];
			userContent.push(...normalized.images);
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			for (const msg of result.messages) {
				messages.push({
					role: "custom",
					customType: msg.customType,
					content: msg.content ?? [],
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				});
			}
			const updateMessage = this._preparePromptAndToolLoadout(result.systemPromptOptions);
			this._runSystemPromptOptions = result.systemPromptOptions;
			if (updateMessage) messages.unshift(updateMessage);
			preparationSucceeded = true;
		} finally {
			this._isPreparingPrompt = false;
			preparationAborted = this._promptPreparationAbortRequested;
			this._promptPreparationAbortRequested = false;
			if (preparationAborted || !preparationSucceeded) this._resolveIdleWaitIfIdle();
		}

		if (preparationAborted) {
			preflightResult?.("handled");
			return;
		}

		preflightResult?.("started");
		await this._runAgentPrompt(messages);
	}

	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		const { name: commandName, args } = parseCommand(text);
		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	private _expandSkillCommand(text: string): string {
		return expandSkillCommand(text, {
			skills: this.resourceLoader.getSkills().skills,
			emitError: (error) => this._extensionRunner.emitError(error),
		});
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<QueuedInputDisposition> {
		return queueUserInput(
			{
				...this._queueTarget(),
				isStreaming: this.isStreaming,
				throwIfExtensionCommand: (value) => this._throwIfExtensionCommand(value),
				runInputHandlers: (value, inputImages, inputSource, streamingBehavior) =>
					this._runInputHandlers(value, inputImages, inputSource, streamingBehavior),
				expandSkillCommand: (value) => this._expandSkillCommand(value),
				getPromptTemplates: () => this.promptTemplates,
			},
			text,
			images,
			behavior,
			source,
		);
	}

	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		queueSteeringInput(this._queueTarget(), text, images);
	}

	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		queueFollowUpInput(this._queueTarget(), text, images);
	}

	private _queueTarget() {
		return {
			steering: this._steeringMessages,
			followUp: this._followUpMessages,
			agent: this.agent,
			emitUpdate: () => this._emitQueueUpdate(),
		};
	}

	private _throwIfExtensionCommand(text: string): void {
		const { name: commandName } = parseCommand(text);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(`Cannot queue command: ${commandName}`);
		}
	}

	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			if (this._isEmittingAgentSettled) {
				this._deferredSettledActions.push(async () => await this._runAgentPrompt(appMessage));
				return;
			}
			await this._runAgentPrompt(appMessage);
		} else if (this.isStreaming) {
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		// Drain each
		while (this._pendingCustomMessages.length > 0) {
			const appMessage = this._pendingCustomMessages.shift();
			if (!appMessage) break;

			this._appendCustomMessage(appMessage);
		}
	}

	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		const { text, images } = parsePromptContent(content);

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this._pendingNextTurnMessages = [];
		this._pendingCustomMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	removeCustomMessages(predicate: (message: CustomMessage) => boolean): number {
		let removed = this.agent.removeQueuedMessages(
			(message) => message.role === "custom" && predicate(message),
		);
		const keep = (messages: CustomMessage[]): CustomMessage[] => {
			const next = messages.filter((message) => !predicate(message));
			removed += messages.length - next.length;
			return next;
		};
		this._pendingNextTurnMessages = keep(this._pendingNextTurnMessages);
		this._pendingCustomMessages = keep(this._pendingCustomMessages);
		return removed;
	}

	get pendingMessageCount(): number {
		return countPendingMessages({
			steering: this._steeringMessages,
			followUp: this._followUpMessages,
			pendingNextTurn: this._pendingNextTurnMessages,
			pendingCustom: this._pendingCustomMessages,
		});
	}

	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	async abort(): Promise<void> {
		if (this._isAgentRunActive) this._agentRunAbortRequested = true;
		if (this._isPreparingPrompt) {
			this._promptPreparationAbortRequested = true;
		}
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		// Settle wait
		if (this.isIdle && !this._isEmittingAgentSettled && !this._isDrainingSettledActions) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	private async _switchModel(
		nextModel: Model<any>,
		thinkingLevel: ThinkingLevel,
		options: ModelMutationOptions,
		source: "set" | "cycle",
	): Promise<void> {
		const previousModel = this.model;
		this.agent.state.model = nextModel;
		if (!modelsAreEqual(previousModel, nextModel)) {
			this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		}
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, previousModel, source);
	}

	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`Missing API key: ${model.provider}/${model.id}`);
		}

		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		await this._switchModel(model, thinkingLevel, options, "set");
	}

	clearModel(): void {
		this.agent.state.model = undefined as unknown as Model<any>;
		this.settingsManager.clearDefaultModelAndProvider();
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase()))
			return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const candidates = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		const next = pickNextModel(candidates, this.model, direction);
		if (!next) return undefined;

		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);
		await this._switchModel(next.model, thinkingLevel, options, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const candidates = this._modelRuntime.getAvailableSnapshot().map((model) => ({ model }));
		const next = pickNextModel(candidates, this.model, direction);
		if (!next) return undefined;

		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model);
		await this._switchModel(next.model, thinkingLevel, options, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level)
			? level
			: this._clampThinkingLevel(level);

		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);

			const model = this.model;
			if (model) {
				this.settingsManager.setModelThinkingLevel(model.provider, model.id, level);
			}
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(
		targetModel?: Model<any>,
		explicitLevel?: ThinkingLevel,
	): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(
				targetModel.provider,
				targetModel.id,
			);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return (
			this.settingsManager.getDefaultThinkingLevel() ??
			this.thinkingLevel ??
			DEFAULT_THINKING_LEVEL
		);
	}

	private _clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	private async _requestExtensionCompaction(
		preparation: CompactionPreparation,
		reason: "manual" | "threshold" | "overflow",
		willRetry: boolean,
		customInstructions: string | undefined,
		signal: AbortSignal,
	): Promise<CompactionResult | undefined> {
		if (!this._extensionRunner.hasHandlers("session_before_compact")) return undefined;

		const outcome = (await this._extensionRunner.emit({
			type: "session_before_compact",
			preparation,
			branchEntries: this.sessionManager.getBranch(),
			customInstructions,
			reason,
			willRetry,
			signal,
		})) as SessionBeforeCompactResult | undefined;

		if (outcome?.cancel) throw new CompactionCancelled();
		return outcome?.compaction;
	}

	private async _summarizeCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		reason: "manual" | "threshold" | "overflow",
		willRetry: boolean,
		customInstructions: string | undefined,
		signal: AbortSignal,
	): Promise<{ result: CompactionResult; fromExtension: boolean }> {
		const extensionResult = await this._requestExtensionCompaction(
			preparation,
			reason,
			willRetry,
			customInstructions,
			signal,
		);
		if (extensionResult) return { result: extensionResult, fromExtension: true };

		const request = await this._getSummarizationRequestAuth(model, signal);
		const result = await compact(
			preparation,
			request.model,
			request.apiKey,
			request.headers,
			customInstructions,
			signal,
			request.thinkingLevel,
			this.agent.streamFunction,
			request.env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined,
			this._summarizationLineage(preparation),
		);
		return { result, fromExtension: false };
	}

	// Summary lineage
	private _summarizationLineage(
		preparation: CompactionPreparation,
	): SummarizationLineage | undefined {
		return buildSummarizationLineage(
			{
				messages: this.sessionManager.buildSessionProjection().messages,
				tools: this.agent.state.tools,
			},
			preparation,
		);
	}

	private async _persistCompaction(
		result: CompactionResult,
		fromExtension: boolean,
		reason: "manual" | "threshold" | "overflow",
		willRetry: boolean,
	): Promise<CompactionResult> {
		assertCompactionResult(result, this.sessionManager.getBranch());
		const firstKeptEntryId = result.firstKeptEntryId ?? null;
		const compactionId = this.sessionManager.appendCompaction(
			result.summary,
			firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
			result.usage,
		);
		this._refreshFinalizedContext();

		const estimatedTokensAfter = estimateMessagesTokens(
			this.sessionManager.buildSessionProjection().messages,
		);
		const savedEntry = this.sessionManager.getEntry(compactionId) as CompactionEntry | undefined;

		if (savedEntry) {
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedEntry,
				fromExtension,
				reason,
				willRetry,
			});
		}

		return { ...result, estimatedTokensAfter };
	}

	private _prepareManualCompaction(model: Model<any>): CompactionPreparation {
		return prepareManualCompaction(
			this.sessionManager.getBranch(),
			this.settingsManager.getCompactionSettings(model),
		);
	}

	private _clearManualCompactionState(controller: AbortController | undefined): void {
		// Keep newer
		if (controller && this._compactionAbortController !== controller) return;
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		if (this._isPreparingPrompt) {
			throw new Error("Prompt preparing");
		}
		await this.abort();
		if (this._compactionAbortController) throw new Error("Compaction running");
		const controller = new AbortController();
		this._compactionAbortController = controller;
		const signal = controller.signal;
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;

		try {
			const model = this.model;
			if (!model) throw new Error(formatNoModelSelectedMessage());

			const preparation = this._prepareManualCompaction(model);
			const summarized = await this._summarizeCompaction(
				preparation,
				model,
				"manual",
				false,
				customInstructions,
				signal,
			);
			fromExtension = summarized.fromExtension;
			if (signal.aborted) throw new CompactionCancelled();

			const result = await this._persistCompaction(
				summarized.result,
				fromExtension,
				"manual",
				false,
			);
			this._clearManualCompactionState(controller);
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result,
				aborted: false,
				willRetry: false,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = isCompactionAborted(error, signal);
			const errorMessage = aborted ? undefined : message;
			this._clearManualCompactionState(controller);
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._clearManualCompactionState(controller);
		}
	}

	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
	): Promise<boolean> {
		return checkCompaction(
			{
				getModel: () => this.model,
				getSettings: () => this.settingsManager.getCompactionSettings(this.model),
				getAgentMessages: () => this.agent.state.messages,
				getBranch: () => this.sessionManager.getBranch(),
				getProjection: () => this.sessionManager.buildSessionProjection(),
				modelForMessage: (message) => this._modelForMessage(message),
				findMessageEntryId: (message) => this._findPersistedMessageEntryId(message),
				getOverflowRecoveryAttempted: () => this._overflowRecoveryAttempted,
				setOverflowRecoveryAttempted: (value) => {
					this._overflowRecoveryAttempted = value;
				},
				omitRecoveryAttempt: (message, results) =>
					this._omitRecoveryAttempt(message, results),
				setFailedResponse: (message) => {
					this._failedResponse = message;
				},
				runAutoCompaction: (reason, willRetry) =>
					this._runAutoCompaction(reason, willRetry),
				emitCompactionEnd: (event) => this._emit(event),
				emitSessionCompactFailed: (event) => this._emitSessionCompactFailed(event),
			},
			assistantMessage,
			skipAbortedCheck,
			toolResults,
		);
	}

	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
	): Promise<boolean> {
		// Abort check
		if (this._agentRunAbortRequested || this._promptPreparationAbortRequested) return false;

		const model = this.model;
		if (!model) return false;

		const settings = this.settingsManager.getCompactionSettings(model);
		const preparation = prepareCompaction(this.sessionManager.getBranch(), settings);
		if (!preparation) return false;

		const abortController = new AbortController();
		const signal = abortController.signal;
		this._autoCompactionAbortController = abortController;
		let fromExtension = false;

		try {
			this._emit({ type: "compaction_start", reason });
			signal.throwIfAborted();

			const summarized = await this._summarizeCompaction(
				preparation,
				model,
				reason,
				willRetry,
				undefined,
				signal,
			);
			fromExtension = summarized.fromExtension;
			signal.throwIfAborted();

			const result = await this._persistCompaction(
				summarized.result,
				fromExtension,
				reason,
				willRetry,
			);
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			return willRetry || this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = isCompactionAborted(error, signal);
			const errorMessage = aborted
				? undefined
				: autoCompactionErrorMessage(reason, message);
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason,
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			return false;
		} finally {
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this._resolveIdleWaitIfIdle();
		}
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(
			this._sessionStartEvent.reason === "reload" ? "reload" : "startup",
		);
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } =
			await this._extensionRunner.emitResourcesDiscover(this._cwd, reason);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(
		entries: Array<{ path: string; extensionPath: string }>,
	): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = isSyntheticPath(entry.extensionPath)
				? undefined
				: dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (isSyntheticPath(extensionPath)) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: PluginHost): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: PluginHost): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner
				.getRegisteredCommands()
				.map((command) => ({
					name: command.invocationName,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader
				.getSkills()
				.skills.map((skill) => ({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				executeTool: (callerId, name, args, options) =>
					this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: {
		activeToolNames?: string[];
		includeAllExtensionTools?: boolean;
	}): void {
		const previousActivatedOnRegistration = new Set(
			[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;

		const built = buildToolRegistry({
			baseToolDefinitions: this._baseToolDefinitions,
			customTools: this._customTools,
			extensionRunner: this._extensionRunner,
			isAllowedTool: (name) => this._isAllowedTool(name),
		});
		this._toolDefinitions = built.definitions;
		this._toolPromptSnippets = built.snippets;
		this._toolPromptGuidelines = built.guidelines;
		this._toolRegistry = built.registry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of built.extensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (
					!previousActivatedOnRegistration.has(toolName) &&
					this._isActivatedOnRegistration(toolName)
				) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		nextActiveToolNames.push(...this._pendingToolNames);

		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	private _isDeclarable(name: string): boolean {
		return isToolDeclarable(this._getToolExposure(name));
	}

	private _isActivatedOnRegistration(name: string): boolean {
		return isToolActivatedOnRegistration(this._toolDefinitions, name);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					files: this._fileReadTracker,
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new PluginHost(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: [...DEFAULT_TOOL_NAMES];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		const previousDefaultTools = new Set(
			this._usesDefaultTools
				? (this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES)
				: [],
		);
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		const addedDefaultTools = this._usesDefaultTools
			? (this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES).filter(
					(name) => !previousDefaultTools.has(name),
				)
			: [];
		for (const name of this.getActiveToolNames()) {
			this._pendingToolNames.add(name);
		}
		this._buildRuntime({
			activeToolNames: [...this.getActiveToolNames(), ...addedDefaultTools],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	private _isRetryableError(message: AssistantMessage): boolean {
		if (
			isContextOverflow(
				message,
				(this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0,
			)
		)
			return false;
		return isRetryableAssistantError(message);
	}

	private _summarizationRetryCallbacks(
		source:
			| { source: "branchSummary" }
			| { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt);
		const controller = new AbortController();
		this._retryAbortController = controller;

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		this._omitRecoveryAttempt(message);

		try {
			await sleep(delayMs, controller.signal);
		} catch {
			this._finishCancelledRetry();
			return false;
		} finally {
			if (this._retryAbortController === controller) {
				this._retryAbortController = undefined;
			}
		}

		return true;
	}

	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	recordBashResult(
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		if (this.isStreaming) {
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		// Drain each
		try {
			while (this._pendingBashMessages.length > 0) {
				const bashMessage = this._pendingBashMessages.shift();
				if (!bashMessage) break;

				this.sessionManager.appendMessage(bashMessage);
			}
		} finally {
			this._refreshFinalizedContext();
		}
	}

	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = {
			type: "session_info_changed",
			name: this.sessionManager.getSessionName(),
		} as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	async navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		if (this._isPreparingPrompt) {
			throw new Error("Prompt preparing");
		}
		if (this.isStreaming) {
			throw new Error("Response streaming");
		}
		if (this.isCompacting) {
			throw new Error("Compaction running");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		if (options.summarize && !this.model) {
			throw new Error("No model available");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry not found: ${targetId}`);
		}

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				try {
					const result = await generateBranchSummary(entriesToSummarize, {
						...(await this._getSummarizationRequestAuth(this.model!, signal)),
						signal,
						customInstructions,
						replaceInstructions,
						reserveTokens: branchSummarySettings.reserveTokens,
						streamFn: this.agent.streamFunction,
						retry: this.settingsManager.getRetrySettings(),
						callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
						sessionId: this.sessionId,
					});
					if (result.aborted) {
						return { cancelled: true, aborted: true };
					}
					if (result.error) {
						throw new Error(result.error);
					}
					summaryText = result.summary;
					summaryUsage = result.usage;
					summaryDetails = {
						readFiles: result.readFiles || [],
						modifiedFiles: result.modifiedFiles || [],
					};
				} catch (error) {
					if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
						return { cancelled: true, aborted: true };
					}
					throw error;
				}
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				newLeafId = targetId;
			}

			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(newLeafId);
			}

			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			this._refreshFinalizedContext();
			this._restoreToolsFromTranscript();

			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	getSessionStats(): SessionStats {
		return computeSessionStats(this.sessionManager.getEntries(), {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			cache: this.cacheSnapshot(),
			contextUsage: this.getContextUsage(),
		});
	}

	cacheSnapshot(): CacheSnapshot {
		return buildCacheSnapshot({
			entries: this.sessionManager.getEntries(),
			resolveModel: (provider, modelId) => this._modelRuntime.getModel(provider, modelId),
			retention: this.settingsManager.getCacheRetention(),
			assumedWindowMs: this.settingsManager.getCacheTtlMs(),
		});
	}

	cacheHealth(): CacheHealth {
		return buildCacheHealth(this.sessionManager.getEntries(), {
			cost: this.model?.cost ?? FREE_COST,
			retention: this.settingsManager.getCacheRetention(),
			resolveModel: (provider, modelId) => this._modelRuntime.getModel(provider, modelId),
		});
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this._limitsModel();
		if (!model) return undefined;

		return computeContextUsage(
			model.contextWindow ?? 0,
			this.sessionManager.buildSessionProjection(),
			this.sessionManager.getBranch(),
		);
	}

	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				this._extensionRunner.resolveToolRenderers(name, () =>
					withBuiltInRenderers(name, this.getToolDefinition(name)),
				),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		return generateBugReportSummary({
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			messages: this.messages,
			hint: options.hint,
			signal: options.signal,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}

	getLastAssistantText(): string | undefined {
		return getLastAssistantText(this.messages);
	}

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	get extensionRunner(): PluginHost {
		return this._extensionRunner;
	}
}
