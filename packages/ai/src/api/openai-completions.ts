import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { requiresExplicitCache } from "../cache/family.ts";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	ChatTemplateKwargValue,
	ImageContent,
	JsonValue,
	Message,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingTokenBudgetField,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getGamaUserAgent } from "../utils/gama-user-agent.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
	type TranscriptContext,
} from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import {
	clampOpenAIPromptCacheKey,
	supportsExplicitOpenAIPromptCache,
} from "./openai-prompt-cache.ts";
import {
	buildBaseOptions,
	clampThinkingBudgetToAnswerRoom,
	thinkingBudgetForLevel,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	thinkingBudgets?: ThinkingBudgets;
}

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

export type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "supportsThinkingTokenBudget"
	| "thinkingTokenBudgetField"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions"
	| "vllmPriority"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
	supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
};

type ResolvedChatTemplateKwargValue = string | number | boolean | null;

type ChatCompletionInstructionMessageParam =
	| ChatCompletionDeveloperMessageParam
	| ChatCompletionSystemMessageParam;

type KimiToolSystemMessageParam = {
	role: "system";
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
	id?: string | null;
	format?: string;
	index?: number;
};

type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.summary";
	summary: string;
};

type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.encrypted";
	data: string;
};

type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.text";
	text: string;
	signature?: string | null;
};

type OpenAIReasoningDetail =
	| OpenAIReasoningSummaryDetail
	| OpenAIEncryptedReasoningDetail
	| OpenAIReasoningTextDetail;

type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: JsonValue[];
	};

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

type CacheControlMessage =
	| ChatCompletionInstructionMessageParam
	| ChatCompletionAssistantMessageParam
	| ChatCompletionToolMessageParam
	| Extract<ChatCompletionMessageParam, { role: "user" }>;

type CacheTarget =
	| { kind: "part"; part: ChatCompletionTextPartWithCacheControl }
	| { kind: "text"; message: ChatCompletionMessageParam; text: string };

type ChunkUsage = {
	prompt_tokens?: number | null;
	completion_tokens?: number | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	prompt_cache_hit_tokens?: number | null;
	cached_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	prompt_tokens_details?: {
		cached_tokens?: number | null;
		cache_write_tokens?: number | null;
	} | null;
	completion_tokens_details?: { reasoning_tokens?: number | null } | null;
};

const OPENAI_COMPLETIONS_REASONING_FIELDS = [
	"reasoning",
	"reasoning_content",
	"reasoning_text",
] as const;

const BREAKPOINT_FIELD = "prompt_cache_breakpoint";

const TOOL_BATCH_CLOSER_TEXT = "(Tool results delivered above. Continue.)";

const TOOL_RESULTS_TEXT = "I have processed the tool results.";

const STREAM_REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

const LAYERED_CACHE_LOOKBACK = 12;

const OPENROUTER_EXPLICIT_CACHE_MODEL_IDS = new Set([
	"deepseek/deepseek-v3.2",
	"qwen/qwen3-max",
	"qwen/qwen-plus",
	"qwen/qwen3.6-plus",
	"qwen/qwen3-coder-plus",
	"qwen/qwen3-coder-flash",
]);

function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

function isOpenAICompletionsReasoningField(
	field: string,
): field is OpenAICompletionsReasoningField {
	return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markAnthropicCloserBreakpoints(
	closers: CacheControlMessage[],
	count: number,
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const closer of closers.slice(-count)) {
		addCacheControlToTextContent(closer, cacheControl);
	}
}

function isCacheableMessage(message: ChatCompletionMessageParam): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "tool";
}

function markCacheTarget(target: CacheTarget, cacheControl: OpenAICompatCacheControl): void {
	if (target.kind === "part") {
		target.part.cache_control = cacheControl;
		return;
	}

	target.message.content = [
		{ type: "text", text: target.text, cache_control: cacheControl },
	] as ChatCompletionTextPartWithCacheControl[];
}

function fillMissingCommonReasoningDetailFields(
	target: OpenAIReasoningDetailBase,
	source: OpenAIReasoningDetail,
): void {
	target.id ??= source.id;
	target.format ||= source.format;
	target.index ??= source.index;
}

function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

function parseOpenAIReasoningDetails(
	signature: string | undefined,
): OpenAIReasoningDetail[] | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail)
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("GAMA_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function resolveThinkingTokenBudgetField(
	compat: Pick<
		OpenAICompletionsCompat,
		"thinkingTokenBudgetField" | "supportsThinkingTokenBudget"
	>,
): ThinkingTokenBudgetField | undefined {
	if (compat.thinkingTokenBudgetField) return compat.thinkingTokenBudgetField;
	if (compat.supportsThinkingTokenBudget) return "thinking_token_budget";
	return undefined;
}

function buildChatTemplateValues(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	values: Record<string, ChatTemplateKwargValue>,
	thinkingBudget?: number,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};
	for (const [key, value] of Object.entries(values)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
		if (resolved !== undefined) {
			resolvedValues[key] = resolved;
		}
	}
	return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}
	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

function convertTools(
	tools: readonly Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			} as unknown as OpenAI.Chat.Completions.ChatCompletionTool;
		}
		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict),
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		} as OpenAI.Chat.Completions.ChatCompletionTool;
	});
}

function mapStopReason(reason: string | null): { stopReason: StopReason; errorMessage?: string } {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

function getClientApiKey(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization"))
		return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function resolveClampedThinkingBudget(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	params: { max_tokens?: number | null; max_completion_tokens?: number | null },
): number | undefined {
	if (!options?.reasoningEffort || !model.reasoning) return undefined;
	const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
	const budget = clampThinkingBudgetToAnswerRoom(
		thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
		ceiling,
	);
	return budget > 0 ? budget : undefined;
}

function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
	closers: CacheControlMessage[],
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);

	if (closers.length > 0 && messages.at(-1) === (closers.at(-1) as ChatCompletionMessageParam)) {
		// Loop anchors.
		markAnthropicCloserBreakpoints(closers, 2, cacheControl);
		return;
	}

	addCacheControlToLastConversationMessage(messages, cacheControl);

	if (closers.length > 0) {
		// Turn anchors.
		markAnthropicCloserBreakpoints(closers, 1, cacheControl);
		return;
	}

	addCacheControlToLayeredMessage(messages, cacheControl);
}

function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	return (
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		(candidate.format === undefined || typeof candidate.format === "string") &&
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

function parseLegacyEncryptedReasoningDetail(
	signature: string | undefined,
): OpenAIEncryptedReasoningDetail | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return isOpenAIReasoningDetail(parsed) &&
			parsed.type === "reasoning.encrypted" &&
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			parsed.data.length > 0
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function appendOpenAIReasoningDetail(
	details: OpenAIReasoningDetail[],
	detail: OpenAIReasoningDetail,
): void {
	const lastDetail = details[details.length - 1];
	if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
		lastDetail.text += detail.text;
		lastDetail.signature ||= detail.signature;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
		lastDetail.summary += detail.summary;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	details.push({ ...detail });
}

function insertToolBatchClosers(messages: ChatCompletionMessageParam[]): CacheControlMessage[] {
	const closers: CacheControlMessage[] = [];
	let index = 0;
	while (index < messages.length) {
		if (messages[index]!.role !== "tool") {
			index += 1;
			continue;
		}

		const batchEnd = index + 1;
		let end = batchEnd;
		while (end < messages.length && messages[end]!.role === "tool") {
			end += 1;
		}

		const closer: CacheControlMessage = {
			role: "user",
			content: [{ type: "text", text: TOOL_BATCH_CLOSER_TEXT }],
		};
		messages.splice(end, 0, closer as ChatCompletionMessageParam);
		closers.push(closer);
		index = end + 1;
	}
	return closers;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		return false;
	}
	switch (detail.type) {
		case "reasoning.summary":
			return typeof detail.summary === "string";
		case "reasoning.encrypted":
			return typeof detail.data === "string";
		case "reasoning.text":
			return (
				typeof detail.text === "string" &&
				(detail.signature === undefined ||
					detail.signature === null ||
					typeof detail.signature === "string")
			);
		default:
			return false;
	}
}

function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

// Second breakpoint.
function addCacheControlToLayeredMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	let seen = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || !isCacheableMessage(message)) continue;
		for (const target of cacheTargets(message)) {
			seen += 1;
			if (seen !== LAYERED_CACHE_LOOKBACK) continue;
			markCacheTarget(target, cacheControl);
			return;
		}
	}
}

function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
	thinkingBudget?: number,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}
	if (value.$var === "thinking.budget") {
		return thinkingBudget;
	}
	const mappedValue = reasoningEffort
		? model.thinkingLevelMap?.[reasoningEffort]
		: model.thinkingLevelMap?.off;
	if (mappedValue === undefined) return reasoningEffort;
	if (typeof mappedValue === "string") return mappedValue;

	return undefined;
}

function cacheTargets(message: ChatCompletionMessageParam): CacheTarget[] {
	const content = message.content;
	if (typeof content === "string") {
		return content.length > 0 ? [{ kind: "text", message, text: content }] : [];
	}
	if (!Array.isArray(content)) return [];
	const targets: CacheTarget[] = [];
	for (let index = content.length - 1; index >= 0; index--) {
		const part = content[index];
		if (part?.type !== "text") continue;
		const textPart = part as ChatCompletionTextPartWithCacheControl;
		if (textPart.cache_control !== undefined) continue;
		targets.push({ kind: "part", part: textPart });
	}
	return targets;
}

function addCacheControlToTextContent(
	message: CacheControlMessage,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}
	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}
	return false;
}

function parseChunkUsage(rawUsage: ChunkUsage, model: Model<"openai-completions">): Usage {
	// Cache accounting.
	const usesOpenAIShape = rawUsage.prompt_tokens !== undefined;
	const promptTokens = rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0;
	const cachedCandidates = [
		rawUsage.prompt_cache_hit_tokens,
		rawUsage.prompt_tokens_details?.cached_tokens,
		rawUsage.cache_read_input_tokens,
		rawUsage.cached_tokens,
	];

	let cacheReadTokens = 0;
	for (const candidate of cachedCandidates) {
		if (typeof candidate === "number") {
			cacheReadTokens = candidate;
			break;
		}
	}
	const cacheWriteTokens =
		rawUsage.prompt_tokens_details?.cache_write_tokens ||
		rawUsage.cache_creation_input_tokens ||
		0;
	const input = usesOpenAIShape
		? Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)
		: promptTokens;
	const outputTokens = rawUsage.completion_tokens || rawUsage.output_tokens || 0;
	const usage: Usage = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function createClient(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
): OpenAI {
	const headers: ProviderHeaders = { "User-Agent": getGamaUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId && compat.sendSessionAffinityHeaders) {
		headers["x-session-id"] = sessionId;
		if (compat.sessionAffinityFormat === "openai") {
			headers.session_id = sessionId;
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}

	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

function markCompletionsBreakpoint(
	message: ChatCompletionMessageParam,
	breakpoint: Record<string, string>,
): boolean {
	if (!isRecord(message)) return false;
	const container = message as Record<string, unknown>;
	if (typeof container.content === "string") {
		if (container.content.length === 0) return false;
		container.content = [
			{ type: "text", text: container.content, [BREAKPOINT_FIELD]: breakpoint },
		];
		return true;
	}
	if (!Array.isArray(container.content)) return false;

	const parts = container.content as Record<string, unknown>[];
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index];
		if (isRecord(part) && part.type === "text") {
			part[BREAKPOINT_FIELD] = breakpoint;
			return true;
		}
	}
	return false;
}

// Cache breakpoints.
function applyExplicitPromptCacheBreakpoints(
	messages: ChatCompletionMessageParam[],
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): void {
	if (!compat.supportsExplicitPromptCacheMode || cacheRetention === "none") return;

	const prefixBreakpoint: Record<string, string> = {
		mode: "explicit",
		...(cacheRetention === "long" && compat.supportsLongCacheRetention ? { ttl: "12h" } : {}),
	};
	const instructionIndex = messages.findIndex(
		(message) => message.role === "developer" || message.role === "system",
	);

	if (instructionIndex !== -1) {
		markCompletionsBreakpoint(messages[instructionIndex]!, prefixBreakpoint);
	}

	for (let index = messages.length - 2; index >= 0; index--) {
		if (index === instructionIndex) continue;
		if (markCompletionsBreakpoint(messages[index]!, { mode: "explicit" })) break;
	}
}

// Gateway closers.
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort:
			model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming:
			model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName:
			model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText:
			model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			model.compat.requiresReasoningContentOnAssistantMessages ??
			detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsThinkingTokenBudget:
			model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		thinkingTokenBudgetField:
			model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools:
			model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		supportsMidConvoSystemMessages:
			model.compat.supportsMidConvoSystemMessages ?? detected.supportsMidConvoSystemMessages,
		supportsMidConvoToolAdditions:
			model.compat.supportsMidConvoToolAdditions ?? detected.supportsMidConvoToolAdditions,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		supportsExplicitPromptCacheMode:
			model.compat.supportsExplicitPromptCacheMode ?? detected.supportsExplicitPromptCacheMode,
		sendSessionAffinityHeaders:
			model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention:
			model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
		sendPromptCacheKey: model.compat.sendPromptCacheKey ?? detected.sendPromptCacheKey,
		vllmPriority: model.compat.vllmPriority,
	};
}

function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	// Hosts
	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" ||
		baseUrl.includes("api.together.ai") ||
		baseUrl.includes("api.together.xyz");
	const isMoonshot =
		provider === "moonshotai" ||
		provider === "moonshotai-cn" ||
		baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isOpenRouterExplicitCacheModel =
		isOpenRouter && OPENROUTER_EXPLICIT_CACHE_MODEL_IDS.has(model.id);
	const isCloudflareWorkersAI =
		provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway =
		provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");

	// DeepSeek match.
	const isDeepSeek =
		provider === "deepseek" ||
		baseUrl.toLowerCase().includes("deepseek.com") ||
		model.id.toLowerCase().includes("deepseek");

	// Flags
	const isNonStandard =
		isNvidia ||
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));

	// Cache format.
	const cacheControlFormat =
		requiresExplicitCache({ id: model.id, provider, baseUrl }) ||
		(isOpenRouter && isOpenRouterExplicitCacheModel)
			? "anthropic"
			: undefined;

	let thinkingFormat: OpenAICompletionsCompat["thinkingFormat"] = "openai";
	if (isOpenRouter) thinkingFormat = "openrouter";
	if (isAntLing) thinkingFormat = "ant-ling";
	if (isTogether) thinkingFormat = "together";
	if (isZai) thinkingFormat = "zai";
	if (isDeepSeek) thinkingFormat = "deepseek";

	return {
		supportsExplicitPromptCacheMode:
			model.compat?.supportsExplicitPromptCacheMode ??
			supportsExplicitOpenAIPromptCache({ id: model.id, provider, baseUrl }),
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok &&
			!isZai &&
			!isMoonshot &&
			!isTogether &&
			!isCloudflareAiGateway &&
			!isNvidia &&
			!isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat,
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsThinkingTokenBudget: false,
		thinkingTokenBudgetField: undefined,
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: isOpenRouter,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsLongCacheRetention: !(
			// Auto cache.
			(
				isDeepSeek ||
				isOpenRouterExplicitCacheModel ||
				isTogether ||
				isCloudflareWorkersAI ||
				isCloudflareAiGateway ||
				isNvidia ||
				isAntLing
			)
		),
		sendPromptCacheKey: false,
	};
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	compat: ResolvedOpenAICompletionsCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const params: ChatCompletionMessageParam[] = [];

	const normalizeToolCallId = (id: string): string => {
		if (id.includes("|")) {
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) {
				return combinedId;
			}
			const hash = shortHash(id).slice(0, 8);
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			return `${prefix}_${hash}`;
		}
		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	const transformedMessages = transformMessages(
		normalizedContext.messages,
		model,
		normalizeToolCallId,
	);
	const transcriptTools = resolveTranscriptTools(
		normalizedContext.messages,
		compat.supportsMidConvoSystemMessages === true &&
			compat.supportsMidConvoToolAdditions === true,
	);
	const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			msg.role === "user"
		) {
			params.push({
				role: "assistant",
				content: TOOL_RESULTS_TEXT,
			});
		}

		if (msg.role === "system") {
			const addedTools = i > 0 && transcriptTools.anchorsAdditions ? (msg.toolsAdded ?? []) : [];
			if (addedTools.length > 0) {
				const kimiToolMessage: KimiToolSystemMessageParam = {
					role: "system",
					tools: convertTools(addedTools, compat),
				};
				params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
			}

			const text = i === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			if (text.length > 0) {
				params.push({
					role: instructionRole,
					content: sanitizeSurrogates(text),
				} as ChatCompletionMessageParam);
			}
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				const content: ChatCompletionContentPart[] = msg.content
					.filter((item) => item.type !== "text" || item.text.length > 0)
					.map((item) => {
						if (item.type === "text") {
							return {
								type: "text",
								text: sanitizeSurrogates(item.text),
							};
						} else {
							return {
								type: "image_url",
								image_url: {
									url: `data:${item.mimeType};base64,${item.data}`,
								},
							};
						}
					});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};
			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map((block) => ({
					type: "text",
					text: sanitizeSurrogates(block.text),
				}));
			// Keep paragraphs.
			const assistantText = assistantTextParts.map((part) => part.text).join("\n\n");
			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			const toolCalls = msg.content.filter(isToolCallBlock);
			const signedReasoningDetails = thinkingBlocks
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				.find((details) => details !== undefined);
			const legacyReasoningDetails = toolCalls
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				.filter((detail): detail is OpenAIEncryptedReasoningDetail => detail !== undefined);
			const preservedReasoningDetails =
				signedReasoningDetails ??
				(legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);
			const nonEmptyThinkingBlocks = thinkingBlocks.filter(
				(block) => block.thinking.trim().length > 0,
			);

			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [
						{ type: "text", text: thinkingText },
						...assistantTextParts,
					] as ChatCompletionTextPartWithCacheControl[];
				} else {
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}
					if (!preservedReasoningDetails) {
						let signature = nonEmptyThinkingBlocks[0]!.thinkingSignature;
						if (model.provider === "opencode-go" && signature === "reasoning") {
							signature = "reasoning_content";
						}
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							(assistantMsg as unknown as Record<string, unknown>)[signature] =
								nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
			} else if (assistantText.length > 0) {
				assistantMsg.content = assistantText;
			}

			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== undefined) {
						return {
							id: tc.id,
							type: "custom",
							custom: {
								name: tc.name,
								input: sanitizeSurrogates(
									getGrammarToolInput(tc.name, tc.arguments, customInputProperty),
								),
							},
						};
					}
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				}) as unknown as ChatCompletionMessageToolCall[];
			}

			if (preservedReasoningDetails) {
				assistantMsg.reasoning_details = preservedReasoningDetails as JsonValue[];
			}

			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				assistantMsg.reasoning_content === undefined
			) {
				assistantMsg.reasoning_content = "";
			}

			const content = assistantMsg.content;
			const hasContent = content !== null && content !== undefined && content.length > 0;

			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks: ChatCompletionContentPartImage[] = [];
			let j = i;
			for (
				;
				j < transformedMessages.length && transformedMessages[j]!.role === "toolResult";
				j++
			) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");
				const hasText = textResult.length > 0;
				const toolResultText = hasText
					? textResult
					: hasImages
						? "(see attached image)"
						: "(no tool output)";

				const toolResultMsg: ChatCompletionToolMessageParam & { name?: string } = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					toolResultMsg.name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}
			i = j - 1;

			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: TOOL_RESULTS_TEXT,
					});
				}
				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}
			continue;
		}

		lastRole = msg.role;
	}

	return params;
}

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(
		context,
		getCompat(model).supportsMidConvoSystemMessages,
	);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		let streamedReasoningDetails: OpenAIReasoningDetail[] | undefined;
		const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
			if (streamedReasoningDetails !== undefined) {
				block.thinkingSignature = JSON.stringify(streamedReasoningDetails);
			}
		};

		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.fetch,
				cacheSessionId,
				compat,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				cacheRetention,
				grammarToolInputProperties,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.chat.completions.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);
			stream.push({ type: "start", partial: output });

			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				customInput?: {
					property: string;
					jsonBuffer: GrammarToolInputJsonBuffer;
				};
				streamIndex?: number;
			}
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			type StreamingToolCallDelta = {
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
				custom?: { name?: string; input?: string };
			};

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			let lastToolCallBlock: StreamingToolCallBlock | undefined;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			const getCustomToolCallInput = (block: StreamingToolCallBlock): string => {
				const property = block.customInput?.property;
				if (property === undefined) return "";
				const value = block.arguments[property];
				return typeof value === "string" ? value : "";
			};
			const appendCustomToolCallInput = (
				block: StreamingToolCallBlock,
				nextInput: string,
				close: boolean,
			): string | undefined => {
				const customInput = block.customInput;
				if (!customInput) return undefined;
				const delta = appendGrammarToolInputJsonDelta(
					customInput.jsonBuffer,
					customInput.property,
					nextInput,
					close,
				);
				block.arguments = { [customInput.property]: nextInput };
				return delta;
			};
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					if (block.customInput) {
						const delta = appendCustomToolCallInput(
							block,
							getCustomToolCallInput(block),
							true,
						);
						if (delta !== undefined) {
							stream.push({
								type: "toolcall_delta",
								contentIndex,
								delta,
								partial: output,
							});
						}
					} else {
						block.arguments = parseStreamingJson(block.partialArgs);
					}
					delete block.partialArgs;
					delete block.customInput;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({
						type: "text_start",
						contentIndex: getContentIndex(textBlock),
						partial: output,
					});
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					stream.push({
						type: "thinking_start",
						contentIndex: getContentIndex(thinkingBlock),
						partial: output,
					});
				}
				return thinkingBlock;
			};
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				let block =
					streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				// Missing index.
				if (
					!block &&
					streamIndex === undefined &&
					!toolCall.id &&
					(!name || name === lastToolCallBlock?.name)
				) {
					block = lastToolCallBlock;
				}

				if (!block) {
					const customInputProperty =
						toolCall.custom && !toolCall.function
							? (grammarToolInputProperties.get(name) ?? "input")
							: undefined;
					const hasCustomInput = customInputProperty !== undefined;
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name,
						arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
						partialArgs: hasCustomInput ? undefined : "",
						customInput: hasCustomInput
							? {
									property: customInputProperty,
									jsonBuffer: { input: "", started: false, closed: false },
								}
							: undefined,
						streamIndex,
					};
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				if (!block.name && name) {
					block.name = name;
				}
				lastToolCallBlock = block;
				if (toolCall.custom && !toolCall.function && !block.customInput) {
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					block.arguments = { [customInputProperty]: "" };
					block.customInput = {
						property: customInputProperty,
						jsonBuffer: { input: "", started: false, closed: false },
					};
					delete block.partialArgs;
				}
				return block;
			};

			// Chunk loop.
			for await (const chunk of openaiStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				if (!chunk || typeof chunk !== "object") continue;
				output.responseId ||= chunk.id;
				if (
					typeof chunk.model === "string" &&
					chunk.model.length > 0 &&
					chunk.model !== model.id
				) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage as ChunkUsage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				if (!chunk.usage && (choice as { usage?: ChunkUsage }).usage) {
					output.usage = parseChunkUsage(
						(choice as { usage?: ChunkUsage }).usage as ChunkUsage,
						model,
					);
				}

				if (choice.finish_reason) {
					output.rawStopReason = choice.finish_reason;
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					hasFinishReason = true;
				}

				if (choice.delta) {
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					const deltaFields = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | null = null;
					for (const field of STREAM_REASONING_FIELDS) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}

					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						if (typeof delta === "string" && delta.length > 0) {
							const thinkingSignature =
								model.provider === "opencode-go" && foundReasoningField === "reasoning"
									? "reasoning_content"
									: foundReasoningField;
							const block = ensureThinkingBlock(thinkingSignature);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					if (choice.delta.tool_calls) {
						for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
							const block = ensureToolCallBlock(toolCall);
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							const name = toolCall.function?.name ?? toolCall.custom?.name;
							if (!block.name && name) {
								block.name = name;
							}

							let delta = "";
							if (toolCall.function?.arguments) {
								delta = toolCall.function.arguments;
								block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
								block.arguments = parseStreamingJson(block.partialArgs);
							} else if (toolCall.custom?.input) {
								const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
								delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					const reasoningDetails = (choice.delta as { reasoning_details?: unknown })
						.reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!isOpenAIReasoningDetail(detail)) continue;
							ensureThinkingBlock("");
							streamedReasoningDetails ??= [];
							appendOpenAIReasoningDetail(streamedReasoningDetails, detail);
						}
					}
				}
			}

			// Finish blocks.
			for (const block of blocks) {
				finishBlock(block);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (!hasFinishReason && !compat.supportsFinishReason) {
				output.stopReason = output.content.some((block) => block.type === "toolCall")
					? "toolUse"
					: "stop";
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
				throw new Error("Stream ended without finish_reason");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Error cleanup.
			for (const block of output.content) {
				if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
				}
				delete (block as { index?: number }).index;
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { customInput?: unknown }).customInput;
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata
				?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				output.errorMessage += `\n${rawMetadata}`;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICompletionsOptions;
	const clampedReasoning = options?.reasoning
		? clampThinkingLevel(model, options.reasoning)
		: undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	return stream(model, context, {
		...base,
		reasoningEffort,
		thinkingBudgets: options?.thinkingBudgets,
	} satisfies OpenAICompletionsOptions);
};

function buildParams(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsMidConvoSystemMessages === true &&
			compat.supportsMidConvoToolAdditions === true,
	);
	const messages = convertMessages(model, context, compat, {
		grammarToolInputProperties,
	});
	const cacheControl = getCompatCacheControl(compat, cacheRetention);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			cacheRetention !== "none" &&
			(model.baseUrl.includes("api.openai.com") ||
				(cacheRetention === "long" && compat.supportsLongCacheRetention) ||
				compat.sendPromptCacheKey === true)
				? clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId)
				: undefined,
		prompt_cache_retention:
			cacheRetention === "long" &&
			compat.supportsLongCacheRetention &&
			!compat.supportsExplicitPromptCacheMode
				? "24h"
				: undefined,
	};

	if (compat.supportsExplicitPromptCacheMode) {
		(params as { prompt_cache_options?: { mode: "explicit" } }).prompt_cache_options = {
			mode: "explicit",
		};
		applyExplicitPromptCacheBreakpoints(messages, compat, cacheRetention);
	}

	if (compat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as { max_tokens?: number }).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertTools(transcriptTools.requestTools, compat);
		if (compat.zaiToolStream) {
			(params as { tool_stream?: boolean }).tool_stream = true;
		}
	} else if (hasToolHistory(context.messages)) {
		params.tools = [];
	}

	if (cacheControl) {
		const closers = insertToolBatchClosers(messages);
		applyAnthropicCacheControl(messages, params.tools, cacheControl, closers);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (compat.vllmPriority !== undefined) {
		(params as { priority?: number }).priority = compat.vllmPriority;
	}

	const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
	const thinkingBudget = resolveClampedThinkingBudget(model, options, params);

	// Thinking format.
	if (compat.thinkingFormat === "zai" && model.reasoning) {
		const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
			thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
			reasoning_effort?: string;
		};
		zaiParams.thinking = options?.reasoningEffort
			? { type: "enabled", clear_thinking: false }
			: { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
			if (typeof effort === "string") {
				zaiParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		(params as { enable_thinking?: boolean }).enable_thinking = !!options?.reasoningEffort;
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const effort =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
			if (typeof effort === "string") {
				(params as { reasoning_effort?: string }).reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		(params as { chat_template_kwargs?: Record<string, unknown> }).chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
			preserve_thinking: true,
		};
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateValues(
			model,
			options,
			compat.chatTemplateKwargs,
			thinkingBudget,
		);
		if (chatTemplateKwargs) {
			(params as { chat_template_kwargs?: Record<string, unknown> }).chat_template_kwargs =
				chatTemplateKwargs;
		}
	} else if (compat.thinkingFormat === "baseten" && model.reasoning) {
		const basetenParams = params as Omit<typeof params, "reasoning_effort"> & {
			chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
			reasoning_effort?: string;
		};
		const chatTemplateArgs = buildChatTemplateValues(
			model,
			options,
			compat.chatTemplateArgs,
			thinkingBudget,
		);
		if (chatTemplateArgs) {
			basetenParams.chat_template_args = chatTemplateArgs;
		}
		if (compat.supportsReasoningEffort) {
			const requestedEffort = options?.reasoningEffort;
			const mappedEffort = requestedEffort
				? model.thinkingLevelMap?.[requestedEffort]
				: model.thinkingLevelMap?.off;
			const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
			if (typeof effort === "string") {
				basetenParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		if (options?.reasoningEffort) {
			(params as { thinking?: { type: string } }).thinking = { type: "enabled" };
		} else if (model.thinkingLevelMap?.off !== null) {
			(params as { thinking?: { type: string } }).thinking = { type: "disabled" };
		}
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			(params as { reasoning_effort?: string }).reasoning_effort =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		if (typeof effort === "string") {
			(params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
		}
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
			reasoning?: { enabled: boolean };
			reasoning_effort?: string;
		};
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			togetherParams.reasoning_effort =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		const stringThinkingParams = params as typeof params & { thinking?: string };
		if (options?.reasoningEffort) {
			stringThinkingParams.thinking =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		} else if (model.thinkingLevelMap?.off !== null) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		(params as { reasoning_effort?: string }).reasoning_effort =
			model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			(params as { reasoning_effort?: string }).reasoning_effort = offValue;
		}
	}

	if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
		Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
	}

	if (model.compat?.openRouterRouting) {
		(params as { provider?: Record<string, unknown> }).provider = model.compat
			.openRouterRouting as unknown as Record<string, unknown>;
	}

	if (model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			(params as { providerOptions?: { gateway: Record<string, string[]> } }).providerOptions = {
				gateway: gatewayOptions,
			};
		}
	}

	Object.assign(params, model.samplingParams, options?.samplingParams);

	return params;
}
