import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	ResourceScope,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	GoogleApiThinkingLevel,
	JsonObject,
	Model,
	ProviderEnv,
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
import { getProviderEnvValue } from "../utils/provider-env.ts";
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

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

let toolCallCounter = 0;

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
	env?: ProviderEnv,
): GoogleGenAI {
	const googleAuthOptions = buildGoogleAuthOptions(env);

	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function buildHttpOptions(
	model: Model<"google-vertex">,
	optionsHeaders?: ProviderHeaders,
): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	const headers = providerHeadersToRecord({
		"User-Agent": getGamaUserAgent(),
		...model.headers,
		...optionsHeaders,
	});

	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;

		if (baseUrlIncludesApiVersion(baseUrl)) httpOptions.apiVersion = "";
	}

	if (headers) httpOptions.headers = headers;

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed) return undefined;
	if (trimmed.includes("{location}")) return undefined;

	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		const parts = url.pathname.split("/");

		return parts.some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	if (!keyFilename) return undefined;

	return { keyFilename };
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey) return undefined;
	if (apiKey === GCP_VERTEX_CREDENTIALS_MARKER) return undefined;
	if (isPlaceholderApiKey(apiKey)) return undefined;

	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);

	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. " +
				"Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}

	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	if (!location) {
		throw new Error(
			"Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
		);
	}

	return location;
}

function buildParams(
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options: GoogleVertexOptions = {},
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
	model: Model<"google-vertex">,
	options: GoogleVertexOptions,
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

export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const transcript = collapseSystemMessages(context);

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex",
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
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error("Custom fetch is not supported by the Google Vertex adapter");
			}

			const apiKey = resolveApiKey(options);
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers)
				: createClient(
						model,
						resolveProject(options),
						resolveLocation(options),
						options?.headers,
						options?.env,
					);

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
				throw new Error("Google Vertex stream ended without a finish reason");
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
	model: Model<"google-vertex">,
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

export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies GoogleVertexOptions;

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
