import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	GoogleApiThinkingLevel,
	JsonObject,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getGamaUserAgent } from "../utils/gama-user-agent.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	collapseSystemMessages,
	getCurrentTools,
	getInitialSystemMessage,
} from "../utils/transcript.ts";
import {
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReason,
	resolveGoogleBudget,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	retryGoogleRequest,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
}

interface HttpOptions {
	baseUrl?: string;
	apiVersion?: string;
	headers?: Record<string, string>;
}

const GOOGLE_FETCH_MESSAGE = "Custom fetch is not supported by the Google Generative AI adapter";

let toolCallCounter = 0;

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	const httpOptions: HttpOptions = model.baseUrl ? { baseUrl: model.baseUrl, apiVersion: "" } : {};
	const headers = providerHeadersToRecord({
		"User-Agent": getGamaUserAgent(),
		...model.headers,
		...optionsHeaders,
	});

	if (headers) httpOptions.headers = headers;

	const hasOptions = Object.keys(httpOptions).length > 0;

	return new GoogleGenAI({ apiKey, httpOptions: hasOptions ? httpOptions : undefined });
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options: GoogleOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);
	const systemMessage = getInitialSystemMessage(context.messages);
	const tools = getCurrentTools(context.messages);
	const systemText = systemMessage ? getSystemMessageText(systemMessage) : "";
	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const toolMode =
		tools.length > 0
			? resolveGoogleFunctionCallingMode(tools, options.toolChoice, supportsStrictMode)
			: undefined;

	const config: GenerateContentConfig = {};
	if (options.temperature !== undefined) config.temperature = options.temperature;
	if (options.maxTokens !== undefined) config.maxOutputTokens = options.maxTokens;
	if (systemText) config.systemInstruction = sanitizeSurrogates(systemText);
	if (tools.length > 0) config.tools = convertTools(tools, false, supportsStrictMode);
	if (toolMode !== undefined) config.toolConfig = { functionCallingConfig: { mode: toolMode } };

	applyThinkingConfig(config, model, options);
	applyAbortSignal(config, options.signal);

	return { model: model.id, contents, config };
}

function applyThinkingConfig(
	config: GenerateContentConfig,
	model: Model<"google-generative-ai">,
	options: GoogleOptions,
): void {
	const thinking = options.thinking;
	if (!thinking || !model.reasoning) return;

	if (!thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);

		return;
	}

	const thinkingConfig: ThinkingConfig = { includeThoughts: true };
	if (thinking.level !== undefined) {
		thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(thinking.level);
	} else if (thinking.budgetTokens !== undefined) {
		thinkingConfig.thinkingBudget = thinking.budgetTokens;
	}

	config.thinkingConfig = thinkingConfig;
}

function applyAbortSignal(config: GenerateContentConfig, signal: AbortSignal | undefined): void {
	if (!signal) return;
	if (signal.aborted) throw new Error("Request aborted");

	config.abortSignal = signal;
}

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const transcript = collapseSystemMessages(context);

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai",
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
			const customFetch = options?.fetch;
			if (customFetch && customFetch !== globalThis.fetch) {
				throw new Error(GOOGLE_FETCH_MESSAGE);
			}

			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

			const client = createClient(model, apiKey, options?.headers);
			let params = buildParams(model, transcript, options);

			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) params = nextParams as GenerateContentParameters;

			const googleStream = await retryGoogleRequest(
				() => client.models.generateContentStream(params),
				options,
			);

			stream.push({ type: "start", partial: output });

			let currentBlock: TextContent | ThinkingContent | null = null;
			const blockIndex = () => output.content.length - 1;

			const endBlock = (block: TextContent | ThinkingContent | null) => {
				if (!block) return;

				if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: block.thinking,
						partial: output,
					});

					return;
				}

				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: block.text,
					partial: output,
				});
			};

			const startBlock = (isThinking: boolean) => {
				if (isThinking) {
					const block: ThinkingContent = {
						type: "thinking",
						thinking: "",
						thinkingSignature: undefined,
					};

					output.content.push(block);
					stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });

					return block;
				}

				const block: TextContent = { type: "text", text: "" };

				output.content.push(block);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });

				return block;
			};

			for await (const chunk of googleStream) {
				await options?.onProviderStreamEvent?.(chunk, model);

				output.responseId ||= chunk.responseId;

				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.text !== undefined) {
						const isThinking = isThinkingPart(part);
						let block: TextContent | ThinkingContent | null = currentBlock;

						if (!block || block.type !== (isThinking ? "thinking" : "text")) {
							endBlock(block);
							block = startBlock(isThinking);
							currentBlock = block;
						}

						appendTextPart(output, stream, block, part.text, part.thoughtSignature);
					}

					if (part.functionCall) {
						endBlock(currentBlock);
						currentBlock = null;

						appendToolCall(output, stream, part.functionCall, part.thoughtSignature);
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);

					const hasToolCalls = output.content.some((block) => block.type === "toolCall");
					if (hasToolCalls && output.stopReason === "stop") output.stopReason = "toolUse";
				}

				applyUsage(output, model, chunk.usageMetadata);
			}

			endBlock(currentBlock);

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") {
				throw new Error("Google stream ended without a finish reason");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(stopReasonError(output.rawStopReason));
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			stripBlockIndexes(output);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));

			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function appendTextPart(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	block: TextContent | ThinkingContent,
	text: string,
	signature: string | undefined,
): void {
	const index = output.content.length - 1;

	if (block.type === "thinking") {
		block.thinking += text;
		block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, signature);

		stream.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: output });

		return;
	}

	block.text += text;
	block.textSignature = retainThoughtSignature(block.textSignature, signature);

	stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
}

interface GoogleFunctionCall {
	id?: string;
	name?: string;
	args?: unknown;
}

function appendToolCall(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	call: GoogleFunctionCall,
	thoughtSignature: string | undefined,
): void {
	const providedId = call.id;
	const hasDuplicateId =
		providedId !== undefined &&
		output.content.some((block) => block.type === "toolCall" && block.id === providedId);
	const generatedId = `${call.name}_${Date.now()}_${++toolCallCounter}`;

	const toolCall: ToolCall = {
		type: "toolCall",
		id: !providedId || hasDuplicateId ? generatedId : providedId,
		name: call.name || "",
		arguments: (call.args as unknown as JsonObject) ?? {},
		...(thoughtSignature && { thoughtSignature }),
	};

	output.content.push(toolCall);
	const index = output.content.length - 1;

	stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
	stream.push({
		type: "toolcall_delta",
		contentIndex: index,
		delta: JSON.stringify(toolCall.arguments),
		partial: output,
	});
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
}

function applyUsage(
	output: AssistantMessage,
	model: Model<"google-generative-ai">,
	usage:
		| {
				promptTokenCount?: number;
				cachedContentTokenCount?: number;
				candidatesTokenCount?: number;
				thoughtsTokenCount?: number;
				totalTokenCount?: number;
		  }
		| null
		| undefined,
): void {
	if (!usage) return;

	const cacheRead = usage.cachedContentTokenCount ?? 0;
	const thoughts = usage.thoughtsTokenCount ?? 0;

	output.usage = {
		input: (usage.promptTokenCount ?? 0) - cacheRead,
		output: (usage.candidatesTokenCount ?? 0) + thoughts,
		cacheRead,
		cacheWrite: 0,
		reasoning: thoughts,
		totalTokens: usage.totalTokenCount ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	calculateCost(model, output.usage);
}

function stopReasonError(rawStopReason: string | undefined): string {
	if (rawStopReason) return `Provider stopped with: ${rawStopReason}`;

	return "An unknown error occurred";
}

function stripBlockIndexes(output: AssistantMessage): void {
	for (const block of output.content) {
		if ("index" in block) delete (block as { index?: number }).index;
	}
}

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleOptions;

	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } });
	}

	const clamped = clampThinkingLevel(model, options.reasoning);
	if (clamped === "off") {
		return stream(model, context, { ...base, thinking: { enabled: false } });
	}

	const level = resolveGoogleThinkingLevel(model, clamped);
	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, level: toGoogleThinkingLevel(level) },
		});
	}

	const budgetTokens = resolveGoogleBudget(model.id, level, options.thinkingBudgets);

	return stream(model, context, { ...base, thinking: { enabled: true, budgetTokens } });
};
