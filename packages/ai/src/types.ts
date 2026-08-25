import type { TelemetryContext } from "@huranth/gama-telemetry";
import type { TSchema } from "typebox";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GamaMessagesOptions } from "./api/gama-messages.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "gama-messages";

export type Api = KnownApi | (string & {});

export type KnownImageApi = "openrouter-images";

export type ImageApi = KnownImageApi | (string & {});

export type KnownClassifierApi =
	| "typesafe-system-one"
	| "cloudflare-workers-ai-system-one"
	| "llama-cpp-classify";

export type ClassifierApi = KnownClassifierApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "radius"
	| "typesafe"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "baseten"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "meta"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";

export type ProviderId = KnownProvider | string;

export type ToolChoice = "auto" | "none";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type GoogleApiThinkingLevel =
	| "THINKING_LEVEL_UNSPECIFIED"
	| "MINIMAL"
	| "LOW"
	| "MEDIUM"
	| "HIGH";

export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

export type ModelThinkingLevel = "off" | ThinkingLevel;

export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
			omitWhenOff?: boolean;
	  };

export type ThinkingTokenBudgetField =
	| "thinking_token_budget"
	| "thinking_budget"
	| "thinking_budget_tokens";

export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type CacheRetention = "none" | "short" | "long";

export type ModelPromptCache = Partial<Record<Exclude<CacheRetention, "none">, number>>;

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

export type ProviderEnv = Record<string, string>;

export type ProviderHeaders = Record<string, string | null>;

export type FetchFunction = typeof globalThis.fetch;

export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface ProviderRequestOptions<TModel = Model<Api>> {
	signal?: AbortSignal;
	telemetryContext?: TelemetryContext;
	apiKey?: string;
	fetch?: FetchFunction;
	env?: ProviderEnv;
	onPayload?: (
		payload: unknown,
		model: TModel,
	) => unknown | undefined | Promise<unknown | undefined>;
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	headers?: ProviderHeaders;
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
	temperature?: number;
	samplingParams?: Record<string, unknown>;
	maxTokens?: number;
	transport?: Transport;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	promptCacheKey?: string;
	websocketConnectTimeoutMs?: number;
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	wait?: number;
}

export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"gama-messages": GamaMessagesOptions;
}

export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

export interface ProviderStreams {
	stream(
		model: Model<Api>,
		context: TranscriptContext,
		options?: StreamOptions,
	): AssistantMessageEventStream;
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredCancelOptions,
	): Promise<void>;
}

export interface ProviderImages {
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface ProviderClassifier {
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ClassifierOptions,
	): Promise<ClassifierResult>;
}

export interface ClassifierOptions extends ProviderRequestOptions<ClassifierModel<ClassifierApi>> {
	temperature?: number;
}

export interface ImagesOptions extends ProviderRequestOptions<ImageModel<ImageApi>> {
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

export interface AnthropicAllowedFallbackModel {
	provider: ProviderId;
	model: string;
	cost: ModelCost;
}

export interface SimpleStreamOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: ThinkingLevel;
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	thinkingBudgets?: ThinkingBudgets;
}

export type StreamFunction<
	TApi extends Api = Api,
	TOptions extends StreamOptions = StreamOptions,
> = (
	model: Model<TApi>,
	context: TranscriptContext,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export type ClassifierFunction<TOptions extends ClassifierOptions = ClassifierOptions> = (
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: TOptions,
) => Promise<ClassifierResult>;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: JsonObject;
	thoughtSignature?: string;
	namespace?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason =
	| "pending"
	| "stop"
	| "length"
	| "toolUse"
	| "error"
	| "aborted"
	| "deferred";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

type IsExactlyJsonValue<T> = [T] extends [JsonValue]
	? [JsonValue] extends [T]
		? true
		: false
	: false;

type IsJsonProperty<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: [Exclude<T, undefined>] extends [never]
			? true
			: IsJsonCompatible<Exclude<T, undefined>>;

type InvalidJsonKeys<T extends object> = {
	[TKey in keyof T]-?: TKey extends string | number
		? IsJsonProperty<T[TKey]> extends true
			? never
			: TKey
		: TKey;
}[keyof T];

type IsJsonCompatible<T> = IsAny<T> extends true
	? false
	: unknown extends T
		? false
		: IsExactlyJsonValue<T> extends true
			? true
			: T extends null | boolean | number | string
				? true
				: T extends undefined
					? false
					: T extends readonly (infer TItem)[]
						? IsJsonCompatible<TItem>
						: T extends (...args: never[]) => unknown
							? false
							: T extends object
								? [InvalidJsonKeys<T>] extends [never]
									? true
									: false
								: false;

export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: [T] extends [JsonValue]
			? T
			: T extends readonly unknown[]
				? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>> }
					: never;

export interface DeferredHandle {
	provider: string;
	modelId: string;
	api: string;
	id: string;
	expiresAt?: number;
	pollAfterMs?: number;
	data?: JsonValue;
}

export interface SystemMessage {
	role: "system";
	content: string | TextContent[];
	sections?: Record<string, string | null>;
	toolsAdded?: Tool[];
	toolsRemoved?: ToolReference[];
	timestamp: number;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	// Mid-turn steer
	steering?: boolean;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string;
	responseId?: string;
	providerThinkingLevel?: string;
	thinkingLevel?: ModelThinkingLevel;
	diagnostics?: AssistantMessageDiagnostic[];
	usage: Usage;
	stopReason: StopReason;
	deferred?: DeferredHandle;
	errorMessage?: string;
	rawStopReason?: string;
	endTurn?: boolean;
	timestamp: number;
	promptHash?: string;
	promptPrefixHash?: string;
	promptMessages?: number;
}

export interface NestedToolCallRecord {
	id: string;
	name: string;
	arguments?: JsonObject;
	argumentsBytes?: number;
	status: "ok" | "error" | "unfinished";
	durationMs?: number;
	error?: string;
}

export interface NestedToolCalls {
	calls: NestedToolCallRecord[];
	complete: boolean;
}

export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true
	? {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextContent | ImageContent)[];
			details?: JsonRepresentation<TDetails>;
			usage?: Usage;
			nestedCalls?: NestedToolCalls;
			isError: boolean;
			timestamp: number;
		}
	: never;

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export type ImagesInputContent = TextContent | ImageContent;

export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImageApi;
	provider: ProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ClassifierChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export interface ClassifierScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}

export interface ClassifierBoolQuestion {
	type: "bool";
	instructions: string;
	criteria: { true: string; false: string };
}

export type ClassifierQuestion =
	| ClassifierChoiceQuestion
	| ClassifierScoreQuestion
	| ClassifierBoolQuestion;

export interface ClassifierContext {
	state: JsonObject;
	questions: Record<string, ClassifierQuestion>;
}

export interface ClassifierChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ClassifierScoreAnswer {
	type: "score";
	score: number;
	confidence: number;
}

export interface ClassifierBoolAnswer {
	type: "bool";
	probability: number;
}

export type ClassifierAnswer =
	| ClassifierChoiceAnswer
	| ClassifierScoreAnswer
	| ClassifierBoolAnswer;

export type ClassifierStopReason = "stop" | "error" | "aborted";

export interface ClassifierResult {
	api: ClassifierApi;
	provider: ProviderId;
	model: string;
	answers: Record<string, ClassifierAnswer>;
	usage?: Usage;
	stopReason: ClassifierStopReason;
	errorMessage?: string;
	timestamp: number;
}

export type GrammarFormat = "openai_lark" | "openai_regex";

export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

export type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

export interface ToolReference {
	name: string;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

export type TranscriptContext = {
	messages: Message[];
	readonly [transcriptContextBrand]: true;
};

export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

export interface OpenAICompletionsCompat {
	supportsStore?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	supportsUsageInStreaming?: boolean;
	supportsFinishReason?: boolean;
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	requiresToolResultName?: boolean;
	requiresAssistantAfterToolResult?: boolean;
	requiresThinkingAsText?: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "baseten"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
	openRouterRouting?: OpenRouterRouting;
	vercelGatewayRouting?: VercelGatewayRouting;
	zaiToolStream?: boolean;
	thinkingTokenBudgetField?: ThinkingTokenBudgetField;
	supportsThinkingTokenBudget?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsMidConvoToolAdditions?: boolean;
	supportsStrictMode?: boolean;
	cacheControlFormat?: "anthropic" | "none";
	supportsExplicitPromptCacheMode?: boolean;
	sendSessionAffinityHeaders?: boolean;
	sessionAffinityFormat?: SessionAffinityFormat;
	supportsLongCacheRetention?: boolean;
	sendPromptCacheKey?: boolean;
	vllmPriority?: number;
}

export interface OpenAIResponsesCompat {
	supportsDeveloperRole?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	sessionAffinityFormat?: SessionAffinityFormat;
	supportsLongCacheRetention?: boolean;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	supportsExplicitPromptCacheMode?: boolean;
	supportsMaxOutputTokens?: boolean;
}

export interface AnthropicMessagesCompat {
	supportsEagerToolInputStreaming?: boolean;
	supportsLongCacheRetention?: boolean;
	sendSessionAffinityHeaders?: boolean;
	sessionAffinityFormat?: "openrouter";
	supportsCacheControlOnTools?: boolean;
	supportsTemperature?: boolean;
	forceAdaptiveThinking?: boolean;
	allowEmptySignature?: boolean;
	supportsStrictTools?: boolean;
	supportsMidConvoEffort?: boolean;
	supportsMidConvoSystemMessages?: boolean;
	supportsMidConvoToolChanges?: boolean;
	allowedFallbackModels?: AnthropicAllowedFallbackModel[];
}

export interface BedrockCompat {
	supportsStrictMode?: boolean;
}

export interface MistralConversationsCompat {
	supportsMidConvoSystemMessages?: boolean;
}

export interface OpenRouterRouting {
	allow_fallbacks?: boolean;
	require_parameters?: boolean;
	data_collection?: "deny" | "allow";
	zdr?: boolean;
	enforce_distillable_text?: boolean;
	order?: string[];
	only?: string[];
	ignore?: string[];
	quantizations?: string[];
	sort?:
		| string
		| {
				by?: string;
				partition?: string | null;
		  };
	max_price?: {
		prompt?: number | string;
		completion?: number | string;
		image?: number | string;
		audio?: number | string;
		request?: number | string;
	};
	preferred_min_throughput?:
		| number
		| {
				p50?: number;
				p75?: number;
				p90?: number;
				p99?: number;
		  };
	preferred_max_latency?:
		| number
		| {
				p50?: number;
				p75?: number;
				p90?: number;
				p99?: number;
		  };
}

export interface VercelGatewayRouting {
	only?: string[];
	order?: string[];
}

export interface ModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelCostTier extends ModelCostRates {
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	tiers?: ModelCostTier[];
}

export interface ModelImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ModelImageInputLimits {
	resize?: ModelImageResizeOptions;
	maxPerMessage?: number;
	maxPerRequest?: number;
}

export interface ModelInputLimits {
	maxRequestBytes?: number;
	images?: ModelImageInputLimits;
}

export interface BaseModel<TApi extends string> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	input: ("text" | "image")[];
	inputLimits?: ModelInputLimits;
	cost: ModelCost;
	headers?: Record<string, string>;
}

export interface Model<TApi extends Api> extends BaseModel<TApi> {
	type?: "chat";
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	promptCache?: ModelPromptCache;
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: TApi extends "mistral-conversations"
						? MistralConversationsCompat
						: never;
}

export interface ImageModel<TApi extends ImageApi> extends BaseModel<TApi> {
	type: "image";
	output: ("text" | "image")[];
}

export interface ClassifierModel<TApi extends ClassifierApi> extends BaseModel<TApi> {
	type: "classifier";
	contextWindow: number;
}

export interface ModelTypeMap {
	chat: Model<Api>;
	image: ImageModel<ImageApi>;
	classifier: ClassifierModel<ClassifierApi>;
}

export type ModelType = keyof ModelTypeMap;

export type AnyModel = ModelTypeMap[ModelType];

declare const transcriptContextBrand: unique symbol;
