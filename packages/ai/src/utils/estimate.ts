import type { ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
import { getSystemMessageText } from "./text.ts";

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;

const ESTIMATED_IMAGE_CHARS = 4800;

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(
	content: string | Array<TextContent | ImageContent>,
): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	if (message.role === "system") {
		const textTokens = estimateTextTokens(getSystemMessageText(message));
		const addedTokens = estimateToolsTokens(message.toolsAdded);
		const removedTokens = estimateToolsTokens(message.toolsRemoved);

		return textTokens + addedTokens + removedTokens;
	}

	if (message.role === "user") {
		return estimateTextAndImageContentTokens(message.content);
	}

	if (message.role === "toolResult") {
		return estimateTextAndImageContentTokens(message.content);
	}

	let chars = 0;

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
			continue;
		}

		if (block.type === "thinking") {
			chars += block.thinking.length;
			continue;
		}

		chars += block.name.length + safeJsonStringify(block.arguments).length;
	}

	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateContextTokens(
	context: TranscriptContext | readonly Message[],
): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;

		for (let index = usageInfo.index + 1; index < messages.length; index++) {
			trailingTokens += estimateMessageTokens(messages[index]);
		}

		return {
			tokens: usageTokens + trailingTokens,
			usageTokens,
			trailingTokens,
			lastUsageIndex: usageInfo.index,
		};
	}

	let tokens = 0;

	for (const message of messages) {
		tokens += estimateMessageTokens(message);
	}

	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;

	return estimateTextTokens(safeJsonStringify(tools));
}

function estimateTextAndImageContentChars(
	content: string | Array<TextContent | ImageContent>,
): number {
	if (typeof content === "string") return content.length;

	let chars = 0;

	for (const block of content) {
		chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	}

	return chars;
}

function getLastAssistantUsageInfo(
	messages: readonly Message[],
): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];

		if (message.role === "assistant") {
			const assistant = message;
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			const usable = assistant.stopReason !== "aborted" && assistant.stopReason !== "error";

			if (usageAppliesToPrefix && usable && calculateContextTokens(assistant.usage) > 0) {
				usageInfo = { usage: assistant.usage, index };
			}
		}

		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}
