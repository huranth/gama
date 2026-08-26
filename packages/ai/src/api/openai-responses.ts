import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getGamaUserAgent } from "../utils/gama-user-agent.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
} from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import {
	clampOpenAIPromptCacheKey,
	supportsExplicitOpenAIPromptCache,
} from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const BREAKPOINT_FIELD = "prompt_cache_breakpoint";
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

function detectSessionAffinityFormat(
	model: Pick<Model<"openai-responses">, "provider" | "baseUrl">,
): "openai" | "openrouter" {
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");

	return isOpenRouter ? "openrouter" : "openai";
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	const isLong = cacheRetention === "long";
	const supportsRetention = compat.supportsLongCacheRetention;
	const usesExplicitMode = compat.supportsExplicitPromptCacheMode;

	return isLong && supportsRetention && !usesExplicitMode ? "24h" : undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
): ResponseCreateParamsStreaming["prompt_cache_options"] {
	return compat.supportsExplicitPromptCacheMode ? { mode: "explicit" } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markBreakpoint(message: unknown, breakpoint: Record<string, unknown>): boolean {
	if (!isRecord(message)) return false;

	if (typeof message.content === "string") {
		if (message.content.length === 0) return false;

		message.content = [
			{ type: "input_text", text: message.content, [BREAKPOINT_FIELD]: breakpoint },
		];

		return true;
	}

	if (!Array.isArray(message.content)) return false;

	const parts = message.content as unknown[];
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index];
		if (!isRecord(part)) continue;
		if (part.type !== "input_text" && part.type !== "output_text") continue;

		part[BREAKPOINT_FIELD] = breakpoint;

		return true;
	}

	return false;
}

// Two breakpoints.
function applyExplicitPromptCacheBreakpoints(
	messages: readonly unknown[],
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): void {
	if (!compat.supportsExplicitPromptCacheMode || cacheRetention === "none") return;

	const prefixBreakpoint = {
		mode: "explicit",
		...(cacheRetention === "long" && compat.supportsLongCacheRetention ? { ttl: "12h" } : {}),
	};
	const instructionIndex = findInstructionIndex(messages);

	if (instructionIndex !== -1) markBreakpoint(messages[instructionIndex], prefixBreakpoint);
	markTailBreakpoint(messages, instructionIndex);
}

function findInstructionIndex(messages: readonly unknown[]): number {
	return messages.findIndex((message) => {
		if (!isRecord(message)) return false;
		if (message.type !== undefined && message.type !== "message") return false;

		return message.role === "developer" || message.role === "system";
	});
}

// Skips instruction.
function markTailBreakpoint(messages: readonly unknown[], instructionIndex: number): void {
	for (let index = messages.length - 2; index >= 0; index--) {
		if (index === instructionIndex) continue;

		const marked = markBreakpoint(messages[index], { mode: "explicit" });
		if (marked) return;
	}
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
		case "fast":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total =
		usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
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

function getClientApiKey(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): string {
	if (apiKey) return apiKey;

	const hasAuthHeader =
		hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization");
	if (hasAuthHeader) return "unused";

	throw new Error(`No API key for provider: ${provider}`);
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat:
			model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode:
			model.compat?.supportsExplicitPromptCacheMode ?? supportsExplicitOpenAIPromptCache(model),
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
	};
}

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { "User-Agent": getGamaUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) addSessionHeaders(headers, compat.sessionAffinityFormat, sessionId);

	if (optionsHeaders) Object.assign(headers, optionsHeaders);

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
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
			api: model.api as Api,
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

		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.fetch,
				cacheSessionId,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				grammarToolInputProperties,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
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

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) =>
					applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = describeError(model, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning
		? clampThinkingLevel(model, options.reasoning)
		: undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	if (!omitUnsupportedFields) {
		applyExplicitPromptCacheBreakpoints(messages, compat, cacheRetention);
	}

	const requestedCacheKey = options?.promptCacheKey ?? options?.sessionId;
	const promptCacheKey =
		cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(requestedCacheKey);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: omitUnsupportedFields
			? undefined
			: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: omitUnsupportedFields ? undefined : getPromptCacheOptions(compat),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && !omitUnsupportedFields) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	applyReasoning(params, model, options);
	Object.assign(params, model.samplingParams, options?.samplingParams);

	return params;
}

function applyReasoning(
	params: ResponseCreateParamsStreaming,
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
): void {
	if (!model.reasoning) return;

	if (options?.reasoningEffort || options?.reasoningSummary) {
		const requested = options?.reasoningEffort;
		const effort = requested ? (model.thinkingLevelMap?.[requested] ?? requested) : "medium";

		params.reasoning = {
			effort: effort as NonNullable<typeof params.reasoning>["effort"],
			summary: options?.reasoningSummary || "auto",
		};
		params.include = ["reasoning.encrypted_content"];

		return;
	}

	const supportsOff = model.thinkingLevelMap?.off !== null;
	if (model.provider !== "github-copilot" && supportsOff) {
		params.reasoning = {
			effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<
				typeof params.reasoning
			>["effort"],
		};
	}

	if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
}

function addSessionHeaders(
	headers: ProviderHeaders,
	format: OpenAIResponsesCompat["sessionAffinityFormat"],
	sessionId: string,
): void {
	if (format === "openrouter") {
		headers["x-session-id"] = sessionId;

		return;
	}

	if (format === "openai") headers.session_id = sessionId;
	headers["x-client-request-id"] = sessionId;
}

function describeError(model: Model<"openai-responses">, error: unknown): string {
	const normalized = normalizeProviderError(error);
	const label = model.provider === "openai" ? "OpenAI" : model.provider;
	const message = formatProviderError(normalized, `${label} API error`);
	const raw = `${normalized.body ?? ""} ${normalized.message}`;
	const isUsageLimit = raw.includes("subscription_sharing_usage_limit_exceeded");

	return isUsageLimit ? `${message}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}` : message;
}
