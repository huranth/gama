import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	StopReason,
	StreamOptions,
	SystemMessage,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
	Usage,
	UserMessage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import {
	resolveTranscript,
	resolveTranscriptTools,
	type TranscriptTools,
} from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

type CompletedResponse = Extract<ResponseStreamEvent, { type: "response.completed" }>["response"];

type IncompleteResponse = Extract<ResponseStreamEvent, { type: "response.incomplete" }>["response"];

export interface OpenAIResponsesStreamOptions {
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	toolOptions?: ConvertResponsesToolsOptions;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	toolSearchResult?: boolean;
}

type StreamingToolCall = ToolCall & {
	partialJson?: string;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
};

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

export function convertResponsesTools(
	tools: readonly Tool[],
	options?: ConvertResponsesToolsOptions,
): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.toolSearchResult ? { defer_loading: true } : {}),
			} satisfies OpenAITool;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const definition: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as Record<string, unknown>,
			...(options?.toolSearchResult ? { defer_loading: true } : {}),
		};

		if (supportsStrictMode) definition.strict = strict;

		return definition as OpenAITool;
	});
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const normalized = resolveTranscript(context, options?.supportsMidConvoSystemMessages);
	const normalizeToolCallId = createToolCallIdNormalizer(model, allowedToolCallProviders);
	const messages = transformMessages(normalized.messages, model, normalizeToolCallId);
	const transcriptTools = resolveTranscriptTools(
		normalized.messages,
		(options?.supportsAdditionalTools ?? false) || (options?.supportsToolSearch ?? false),
	);
	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	const instructionRole =
		model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";

	const input: ResponseInput = [];
	let turn = 0;
	let messageCount = 0;

	for (const message of messages) {
		const isLeadingSystem = messageCount++ === 0 && message.role === "system";

		if (message.role === "system") {
			const additions = readSystemAdditions(
				message,
				isLeadingSystem,
				turn,
				transcriptTools,
				options,
			);
			input.push(...additions);

			const skipText = isLeadingSystem && !includeSystemPrompt;
			const text = isLeadingSystem
				? getSystemMessageText(message)
				: renderSystemMessageUpdate(message);
			if (!skipText && text.length > 0) {
				input.push({ role: instructionRole, content: sanitizeSurrogates(text) });
			}
		} else if (message.role === "user") {
			const content = convertUserContent(message);
			if (content.length > 0) input.push({ role: "user", content });
		} else if (message.role === "assistant") {
			input.push(...convertAssistantMessage(message, model, options, turn));
		} else if (message.role === "toolResult") {
			input.push(convertToolResult(message, model, options));
		}

		if (!isLeadingSystem) turn++;
	}

	return input;
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	const slots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	let sawTerminalEvent = false;

	const applyPhaseStopReason = (item: ResponseOutputItem): void => {
		if (item.type === "message" && item.phase === "final_answer") {
			output.stopReason = "stop";
		}
	};

	const addSlot = (
		outputIndex: number,
		block: TextContent | ThinkingContent | StreamingToolCall,
	): ResponsesOutputSlot => {
		output.content.push(block);

		const contentIndex = output.content.length - 1;
		const slot: ResponsesOutputSlot =
			block.type === "thinking"
				? { type: "thinking", block, contentIndex }
				: block.type === "text"
					? { type: "text", block, contentIndex }
					: { type: "toolCall", block, contentIndex };

		slots.set(outputIndex, slot);

		return slot;
	};

	const createSlot = (
		outputIndex: number,
		item: ResponseOutputItem,
	): ResponsesOutputSlot | undefined => {
		if (item.type === "reasoning") {
			const slot = addSlot(outputIndex, { type: "thinking", thinking: "" });
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });

			return slot;
		}

		if (item.type === "message") {
			applyPhaseStopReason(item);

			const slot = addSlot(outputIndex, { type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });

			return slot;
		}

		if (item.type === "function_call") {
			const slot = addSlot(outputIndex, {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				partialJson: item.arguments || "",
			});
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });

			return slot;
		}

		if (item.type === "custom_tool_call") {
			const property = options?.grammarToolInputProperties?.get(item.name) ?? "input";
			const slot = addSlot(outputIndex, {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: { [property]: item.input || "" },
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				customInput: {
					property,
					jsonBuffer: { input: "", started: false, closed: false },
				},
			});
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });

			return slot;
		}

		return undefined;
	};

	const findSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = slots.get(outputIndex);
		if (slot?.type !== type) return undefined;

		return slot as Extract<ResponsesOutputSlot, { type: TType }>;
	};

	const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
		if (delta === undefined) return;

		stream.push({
			type: "toolcall_delta",
			contentIndex: slot.contentIndex,
			delta,
			partial: output,
		});
	};

	const finishItem = (outputIndex: number, item: ResponseOutputItem): void => {
		applyPhaseStopReason(item);

		const slot = slots.get(outputIndex) ?? createSlot(outputIndex, item);

		if (item.type === "reasoning" && slot?.type === "thinking") {
			const summaryText = item.summary?.map((part) => part.text).join("\n\n") || "";
			const contentText = item.content?.map((part) => part.text).join("\n\n") || "";

			slot.block.thinking = summaryText || contentText || slot.block.thinking;
			slot.block.thinkingSignature = JSON.stringify(item);
			reasoningBlocksById.set(item.id, slot.block);
			stream.push({
				type: "thinking_end",
				contentIndex: slot.contentIndex,
				content: slot.block.thinking,
				partial: output,
			});
			slots.delete(outputIndex);

			return;
		}

		if (item.type === "message" && slot?.type === "text") {
			const parts = item.content ?? [];
			const finalText = parts
				.map((part) => (part.type === "output_text" ? part.text : part.refusal))
				.join("");

			if (finalText.length > 0) slot.block.text = finalText;

			slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
			stream.push({
				type: "text_end",
				contentIndex: slot.contentIndex,
				content: slot.block.text,
				partial: output,
			});
			slots.delete(outputIndex);

			return;
		}

		if (
			item.type === "function_call" &&
			slot?.type === "toolCall" &&
			slot.block.partialJson !== undefined
		) {
			const json = item.arguments || slot.block.partialJson || "{}";

			slot.block.arguments = parseStreamingJson(json);
			if (item.namespace !== undefined) slot.block.namespace = item.namespace;

			delete slot.block.partialJson;
			stream.push({
				type: "toolcall_end",
				contentIndex: slot.contentIndex,
				toolCall: slot.block,
				partial: output,
			});
			slots.delete(outputIndex);

			return;
		}

		if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
			const nextInput = item.input ?? getCustomToolCallInput(slot.block);

			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, nextInput, true));
			if (item.namespace !== undefined) slot.block.namespace = item.namespace;

			delete slot.block.customInput;
			stream.push({
				type: "toolcall_end",
				contentIndex: slot.contentIndex,
				toolCall: slot.block,
				partial: output,
			});
			slots.delete(outputIndex);
		}
	};

	const backfillSignatures = (responseOutput: ResponseOutputItem[]): void => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;

			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const stored = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			if (stored.encrypted_content) continue;

			block.thinkingSignature = JSON.stringify({
				...stored,
				encrypted_content: item.encrypted_content,
			});
		}
	};

	const finalizeResponse = (response: CompletedResponse | IncompleteResponse): void => {
		sawTerminalEvent = true;
		backfillSignatures(response.output ?? []);

		if (response?.id) output.responseId = response.id;
		if (typeof response?.model === "string" && response.model !== model.id) {
			output.responseModel ??= response.model;
		}

		if (response?.usage) output.usage = readUsage(response);

		calculateCost(model, output.usage);

		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);

			options.applyServiceTierPricing(output.usage, serviceTier);
		}

		applyStopReason(output, response);
	};

	for await (const event of openaiStream) {
		await options?.onProviderStreamEvent?.(event, model);

		switch (event.type) {
			case "response.created": {
				output.responseId = event.response.id;
				if (typeof event.response.model === "string" && event.response.model !== model.id) {
					output.responseModel ??= event.response.model;
				}
				break;
			}

			case "response.output_item.added": {
				createSlot(event.output_index, event.item);
				break;
			}

			case "response.reasoning_summary_text.delta":
			case "response.reasoning_text.delta": {
				const slot = findSlot(event.output_index, "thinking");
				if (!slot) break;

				slot.block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: slot.contentIndex,
					delta: event.delta,
					partial: output,
				});
				break;
			}

			case "response.reasoning_summary_part.done": {
				const slot = findSlot(event.output_index, "thinking");
				if (!slot) break;

				slot.block.thinking += "\n\n";
				stream.push({
					type: "thinking_delta",
					contentIndex: slot.contentIndex,
					delta: "\n\n",
					partial: output,
				});
				break;
			}

			case "response.output_text.delta":
			case "response.refusal.delta": {
				const slot = findSlot(event.output_index, "text");
				if (!slot) break;

				slot.block.text += event.delta;
				stream.push({
					type: "text_delta",
					contentIndex: slot.contentIndex,
					delta: event.delta,
					partial: output,
				});
				break;
			}

			case "response.function_call_arguments.delta": {
				const slot = findSlot(event.output_index, "toolCall");
				if (!slot || slot.block.partialJson === undefined) break;

				slot.block.partialJson += event.delta;
				slot.block.arguments = parseStreamingJson(slot.block.partialJson);
				pushToolCallDelta(slot, event.delta);
				break;
			}

			case "response.function_call_arguments.done": {
				const slot = findSlot(event.output_index, "toolCall");
				if (!slot || slot.block.partialJson === undefined) break;

				const previousJson = slot.block.partialJson;
				const delta = event.arguments.startsWith(previousJson)
					? event.arguments.slice(previousJson.length)
					: "";

				slot.block.partialJson = event.arguments;
				slot.block.arguments = parseStreamingJson(slot.block.partialJson);

				if (delta.length > 0) pushToolCallDelta(slot, delta);
				break;
			}

			case "response.custom_tool_call_input.delta": {
				const slot = findSlot(event.output_index, "toolCall");
				if (!slot?.block.customInput) break;

				const nextInput = getCustomToolCallInput(slot.block) + event.delta;
				pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, nextInput, false));
				break;
			}

			case "response.custom_tool_call_input.done": {
				const slot = findSlot(event.output_index, "toolCall");
				if (!slot?.block.customInput) break;

				pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true));
				break;
			}

			case "response.output_item.done": {
				finishItem(event.output_index, event.item);
				break;
			}

			case "response.completed":
			case "response.incomplete": {
				finalizeResponse(event.response);
				break;
			}

			case "response.failed": {
				sawTerminalEvent = true;
				output.rawStopReason = event.response?.status;
				throw new Error(readFailureMessage(event.response));
			}

			case "error": {
				throw new Error(`Error Code ${event.code}: ${event.message}`);
			}
		}
	}

	if (!sawTerminalEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}

	if (output.stopReason !== "toolUse") return;

	for (const block of output.content) {
		if (block.type !== "toolCall") continue;

		const toolCall = block as StreamingToolCall;
		const isUnfinished = toolCall.partialJson !== undefined || toolCall.customInput !== undefined;
		if (!isUnfinished) continue;

		throw new Error(
			`OpenAI Responses stream completed with an unfinished tool call: ` +
				`${toolCall.name} (${toolCall.id})`,
		);
	}
}

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;

	return JSON.stringify(payload);
}

function getCustomToolCallInput(block: StreamingToolCall): string {
	const property = block.customInput?.property;
	if (property === undefined) return "";

	const value = block.arguments[property];

	return typeof value === "string" ? value : "";
}

function appendCustomToolCallInput(
	block: StreamingToolCall,
	nextInput: string,
	close: boolean,
): string | undefined {
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
}

function mapStopReason(
	status: string | undefined,
	incompleteReason: string | undefined,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };

	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "max_output_tokens") return { stopReason: "length" };

			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			const _exhaustive = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	const textResult = content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const images = content.filter((item): item is ImageContent => item.type === "image");
	const hasText = textResult.length > 0;

	if (images.length === 0 || !model.input.includes("image")) {
		let text = textResult;
		if (!hasText) text = images.length > 0 ? "(see attached image)" : "(no tool output)";

		return sanitizeSurrogates(text);
	}

	const output: ToolResultOutputContent = [];
	if (hasText) output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });

	for (const image of images) {
		output.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}

	return output;
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;

	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}

				return { id: parsed.id };
			}
		} catch {}
	}

	return { id: signature };
}

function readUsage(response: CompletedResponse | IncompleteResponse): Usage {
	const inputDetails = response.usage?.input_tokens_details;
	const cachedTokens = inputDetails?.cached_tokens || 0;
	const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
	const inputTokens = response.usage?.input_tokens || 0;

	return {
		input: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
		output: response.usage?.output_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: response.usage?.output_tokens_details?.reasoning_tokens || 0,
		totalTokens: response.usage?.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function applyStopReason(
	output: AssistantMessage,
	response: CompletedResponse | IncompleteResponse,
): void {
	const status = response?.status;
	const details = response?.incomplete_details;
	const incompleteReason = typeof details?.reason === "string" ? details.reason : undefined;

	output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;

	const mapped = mapStopReason(status, incompleteReason);
	output.stopReason = mapped.stopReason;

	if (mapped.errorMessage === undefined) delete output.errorMessage;
	else output.errorMessage = mapped.errorMessage;

	const hasToolCall = output.content.some((block) => block.type === "toolCall");
	if (hasToolCall && output.stopReason === "stop") output.stopReason = "toolUse";
}

function readFailureMessage(
	response: Extract<ResponseStreamEvent, { type: "response.failed" }>["response"],
): string {
	const error = response?.error;
	if (error) return `${error.code || "unknown"}: ${error.message || "no message"}`;

	const reason = response?.incomplete_details?.reason;
	if (reason) return `incomplete: ${reason}`;

	return "Unknown error (no error details in response)";
}

function createToolCallIdNormalizer<TApi extends Api>(
	model: Model<TApi>,
	allowedToolCallProviders: ReadonlySet<string>,
): (id: string, targetModel: Model<TApi>, source: AssistantMessage) => string {
	return (id, _targetModel, source) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);

		const [callId, itemId] = id.split("|") as [string, string];
		const normalizedCallId = normalizeIdPart(callId);
		const isForeign = source.provider !== model.provider || source.api !== model.api;

		let itemPart = isForeign ? `fc_${shortHash(itemId)}` : normalizeIdPart(itemId);
		if (!itemPart.startsWith("fc_")) itemPart = normalizeIdPart(`fc_${itemPart}`);

		return `${normalizedCallId}|${normalizeIdPart(itemPart)}`;
	};
}

function normalizeIdPart(part: string): string {
	const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
	const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;

	return truncated.replace(/_+$/, "");
}

function convertUserContent(message: UserMessage): ResponseInputContent[] {
	if (typeof message.content === "string") {
		return [{ type: "input_text", text: sanitizeSurrogates(message.content) }];
	}

	return message.content.map((item): ResponseInputContent => {
		if (item.type === "text") {
			return {
				type: "input_text",
				text: sanitizeSurrogates(item.text),
			} satisfies ResponseInputText;
		}

		return {
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		} satisfies ResponseInputImage;
	});
}

function convertAssistantMessage<TApi extends Api>(
	message: AssistantMessage,
	model: Model<TApi>,
	options: ConvertResponsesMessagesOptions | undefined,
	turn: number,
): ResponseInput {
	const output: (ResponseInputItem | ResponseOutputItem)[] = [];
	const isSameProviderAndApi = message.provider === model.provider && message.api === model.api;
	const isSameModel = isSameProviderAndApi && message.model === model.id;
	const isDifferentModel = isSameProviderAndApi && message.model !== model.id;

	let textBlockIndex = 0;

	for (const block of message.content) {
		if (block.type === "thinking") {
			pushReasoning(output, block);
			continue;
		}

		if (block.type === "text") {
			output.push(convertAssistantText(block, turn, textBlockIndex));
			textBlockIndex++;
			continue;
		}

		if (block.type === "toolCall") {
			const item = convertAssistantToolCall(block, isSameModel, isDifferentModel, options);
			output.push(item);
		}
	}

	return output as ResponseInput;
}

function pushReasoning(
	output: (ResponseInputItem | ResponseOutputItem)[],
	block: ThinkingContent,
): void {
	if (!block.thinkingSignature) return;

	try {
		output.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
	} catch {
		// Replay text.
	}
}

function convertAssistantText(
	block: TextContent,
	turn: number,
	textBlockIndex: number,
): ResponseOutputMessage {
	const signature = parseTextSignature(block.textSignature);
	const fallbackId = textBlockIndex === 0 ? `msg_pi_${turn}` : `msg_pi_${turn}_${textBlockIndex}`;

	let messageId = signature?.id ? signature.id : fallbackId;
	if (messageId.length > 64) messageId = `msg_${shortHash(messageId)}`;

	return {
		type: "message",
		role: "assistant",
		content: [
			{
				type: "output_text",
				text: sanitizeSurrogates(block.text),
				annotations: [],
			},
		],
		status: "completed",
		id: messageId,
		phase: signature?.phase,
	};
}

function convertAssistantToolCall(
	toolCall: ToolCall,
	isSameModel: boolean,
	isDifferentModel: boolean,
	options: ConvertResponsesMessagesOptions | undefined,
): ResponseOutputItem {
	const [callId, rawItemId] = toolCall.id.split("|") as [string, string | undefined];
	const customProperty = options?.grammarToolInputProperties?.get(toolCall.name);
	const expectedPrefix = customProperty === undefined ? "fc_" : "ctc_";
	const hasValidItemId = !!rawItemId?.startsWith(expectedPrefix) && !isDifferentModel;
	const itemId = hasValidItemId ? rawItemId : undefined;
	const namespace =
		isSameModel && toolCall.namespace !== undefined ? { namespace: toolCall.namespace } : {};

	if (customProperty !== undefined) {
		const input = getGrammarToolInput(toolCall.name, toolCall.arguments, customProperty);

		return {
			type: "custom_tool_call",
			id: itemId,
			call_id: callId,
			name: toolCall.name,
			input: sanitizeSurrogates(input),
			...namespace,
		};
	}

	return {
		type: "function_call",
		id: itemId,
		call_id: callId,
		name: toolCall.name,
		arguments: JSON.stringify(toolCall.arguments),
		...namespace,
	};
}

function convertToolResult<TApi extends Api>(
	message: ToolResultMessage,
	model: Model<TApi>,
	options: ConvertResponsesMessagesOptions | undefined,
): ResponseInputItem {
	const [callId] = message.toolCallId.split("|") as [string];
	const output = convertToolResultOutput(model, message.content);
	const isCustom = options?.grammarToolInputProperties?.has(message.toolName);

	if (isCustom) return { type: "custom_tool_call_output", call_id: callId, output };

	return { type: "function_call_output", call_id: callId, output };
}

function readSystemAdditions(
	message: SystemMessage,
	isLeadingSystem: boolean,
	turn: number,
	transcriptTools: TranscriptTools,
	options: ConvertResponsesMessagesOptions | undefined,
): ResponseInput {
	if (isLeadingSystem) return [];

	const tools = transcriptTools.anchorsAdditions ? (message.toolsAdded ?? []) : [];
	if (tools.length === 0) return [];

	if (options?.supportsAdditionalTools) {
		return [
			{
				type: "additional_tools",
				role: "developer",
				tools: convertResponsesTools(tools, options.toolOptions),
			} satisfies ResponseInputItem,
		];
	}

	if (!options?.supportsToolSearch) return [];

	const names = tools.map((tool) => tool.name);
	const callId = `gama_tool_load_${shortHash(`system:${turn}:${names.join(",")}`)}`;

	return [
		{
			type: "tool_search_call",
			call_id: callId,
			execution: "client",
			status: "completed",
			arguments: { query: names.join(" "), limit: names.length },
		} satisfies ResponseInputItem,
		{
			type: "tool_search_output",
			call_id: callId,
			execution: "client",
			status: "completed",
			tools: convertResponsesTools(tools, { ...options.toolOptions, toolSearchResult: true }),
		} satisfies ResponseToolSearchOutputItemParam,
	];
}
