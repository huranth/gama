import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const toolCallIds = new Map<string, string>();
	const normalized = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAware = downgradeUnsupportedImages(normalized, model);
	const transformed = imageAware.map((msg) =>
		transformMessage(msg, model, toolCallIds, normalizeToolCallId),
	);

	return dropUnansweredToolCalls(transformed);
}

function transformMessage<TApi extends Api>(
	msg: Message,
	model: Model<TApi>,
	toolCallIds: Map<string, string>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message {
	if (msg.role === "system" || msg.role === "user") return msg;

	if (msg.role === "toolResult") {
		const normalizedId = toolCallIds.get(msg.toolCallId);
		if (normalizedId && normalizedId !== msg.toolCallId) {
			return { ...msg, toolCallId: normalizedId };
		}

		return msg;
	}

	if (msg.role === "assistant") {
		const content = transformAssistantContent(msg, model, toolCallIds, normalizeToolCallId);

		return { ...msg, content };
	}

	return msg;
}

function transformAssistantContent<TApi extends Api>(
	message: AssistantMessage,
	model: Model<TApi>,
	toolCallIds: Map<string, string>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): (TextContent | ThinkingContent | ToolCall)[] {
	const isSameModel = sameModel(message, model);
	const blocks: (TextContent | ThinkingContent | ToolCall)[] = [];

	for (const block of message.content) {
		if (block.type === "thinking") {
			const next = transformThinking(block, isSameModel);
			if (next) blocks.push(next);
			continue;
		}

		if (block.type === "text") {
			blocks.push(isSameModel ? block : { type: "text", text: block.text });
			continue;
		}

		if (block.type === "toolCall") {
			const next = transformToolCall(
				block,
				model,
				message,
				isSameModel,
				toolCallIds,
				normalizeToolCallId,
			);
			blocks.push(next);
			continue;
		}

		blocks.push(block);
	}

	return blocks;
}

function transformThinking(
	block: ThinkingContent,
	isSameModel: boolean,
): ThinkingContent | TextContent | undefined {
	if (block.redacted) return isSameModel ? block : undefined;
	if (isSameModel && block.thinkingSignature) return block;

	const hasThinking = block.thinking.trim().length > 0;
	if (!hasThinking) return undefined;
	if (isSameModel) return block;

	return { type: "text", text: block.thinking };
}

function transformToolCall<TApi extends Api>(
	toolCall: ToolCall,
	model: Model<TApi>,
	source: AssistantMessage,
	isSameModel: boolean,
	toolCallIds: Map<string, string>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): ToolCall {
	let result = toolCall;

	if (!isSameModel && toolCall.thoughtSignature) {
		result = { ...toolCall };
		delete (result as { thoughtSignature?: string }).thoughtSignature;
	}

	if (isSameModel || !normalizeToolCallId) return result;

	const normalizedId = normalizeToolCallId(toolCall.id, model, source);
	if (normalizedId === toolCall.id) return result;

	toolCallIds.set(toolCall.id, normalizedId);

	return { ...result, id: normalizedId };
}

function sameModel<TApi extends Api>(message: AssistantMessage, model: Model<TApi>): boolean {
	return (
		message.provider === model.provider && message.api === model.api && message.model === model.id
	);
}

function replaceImagesWithPlaceholder(
	content: (TextContent | ImageContent)[],
	placeholder: string,
): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}

			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
): Message[] {
	if (model.input.includes("image")) return messages;

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			const content = replaceImagesWithPlaceholder(
				msg.content,
				NON_VISION_USER_IMAGE_PLACEHOLDER,
			);

			return { ...msg, content };
		}

		if (msg.role === "toolResult") {
			const content = replaceImagesWithPlaceholder(
				msg.content,
				NON_VISION_TOOL_IMAGE_PLACEHOLDER,
			);

			return { ...msg, content };
		}

		return msg;
	});
}

function dropUnansweredToolCalls(messages: Message[]): Message[] {
	const result: Message[] = [];
	const heldSystemMessages: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let answeredIds = new Set<string>();

	const closeToolCalls = () => {
		for (const call of pendingToolCalls) {
			if (answeredIds.has(call.id)) continue;

			result.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: Date.now(),
			} as ToolResultMessage);
		}

		pendingToolCalls = [];
		answeredIds = new Set();
		result.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			closeToolCalls();
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;

			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls as ToolCall[];
				answeredIds = new Set();
			}

			result.push(message);
			continue;
		}

		if (message.role === "toolResult") {
			answeredIds.add(message.toolCallId);
			result.push(message);
			continue;
		}

		if (message.role === "system") {
			if (pendingToolCalls.length > 0) heldSystemMessages.push(message);
			else result.push(message);
			continue;
		}

		closeToolCalls();
		result.push(message);
	}

	closeToolCalls();

	return result;
}
