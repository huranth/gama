import type {
	GenerateContentConfig,
	GenerateContentParameters,
	GenerateContentResponse,
	ThinkingConfig,
} from "@google/genai";
import { calculateCost } from "../registry.ts";
import type {
	AssistantMessage,
	GoogleApiThinkingLevel,
	JsonObject,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { ReplyStream } from "../utils/event-stream.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import {
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReason,
	resolveGoogleFunctionCallingMode,
	retainThoughtSignature,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
} from "./google-shared.ts";

type GoogleApi = "google-generative-ai" | "google-vertex";

export interface GoogleRequestOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
}

let toolCallCounter = 0;

export function stripBlockIndexes(output: AssistantMessage): void {
	for (const block of output.content) {
		if ("index" in block) delete (block as { index?: number }).index;
	}
}

export function resolveTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;

	return Math.floor(value);
}

function applyAbortSignal(config: GenerateContentConfig, signal: AbortSignal | undefined): void {
	if (!signal) return;
	if (signal.aborted) throw new Error("Request aborted");

	config.abortSignal = signal;
}

function applyThinkingConfig<T extends GoogleApi>(
	config: GenerateContentConfig,
	model: Model<T>,
	options: GoogleRequestOptions,
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

export function buildGoogleParams<T extends GoogleApi>(
	model: Model<T>,
	context: TranscriptContext,
	options: GoogleRequestOptions = {},
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

interface GoogleFunctionCall {
	id?: string;
	name?: string;
	args?: unknown;
}

interface ConsumeArgs<T extends GoogleApi> {
	googleStream: AsyncIterable<GenerateContentResponse>;
	stream: ReplyStream;
	output: AssistantMessage;
	model: Model<T>;
	options?: GoogleRequestOptions;
	pendingMessage: string;
}

export async function consumeGoogleStream<T extends GoogleApi>(
	args: ConsumeArgs<T>,
): Promise<void> {
	const { googleStream, stream, output, model, options, pendingMessage } = args;

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
	if (output.stopReason === "pending") throw new Error(pendingMessage);

	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error(stopReasonError(output.rawStopReason));
	}

	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end();
}

function appendTextPart(
	output: AssistantMessage,
	stream: ReplyStream,
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

function appendToolCall(
	output: AssistantMessage,
	stream: ReplyStream,
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

function applyUsage<T extends GoogleApi>(
	output: AssistantMessage,
	model: Model<T>,
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

	const cacheRead = Math.max(0, usage.cachedContentTokenCount ?? 0);
	const thoughts = Math.max(0, usage.thoughtsTokenCount ?? 0);
	const input = Math.max(0, (usage.promptTokenCount ?? 0) - cacheRead);
	const outputTokens = (usage.candidatesTokenCount ?? 0) + thoughts;

	output.usage = {
		input,
		output: outputTokens,
		cacheRead,
		cacheWrite: 0,
		reasoning: thoughts,
		totalTokens: usage.totalTokenCount || input + cacheRead + outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	calculateCost(model, output.usage);
}

function stopReasonError(rawStopReason: string | undefined): string {
	if (rawStopReason) return `Provider error: ${rawStopReason}`;

	return "Unknown error";
}
