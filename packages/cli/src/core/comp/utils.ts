import type { AgentMessage } from "@huranth/gama-agent-core";
import { contentText, type Message } from "@huranth/gama-ai";

const TOOL_RESULT_MAX_CHARS = 1000;

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export const SUMMARIZATION_SYSTEM_PROMPT =
	`You are a context summarization assistant.
Read a conversation between a user and an AI assistant, then ` +
	`produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT ` +
	`respond to any questions in the conversation. ONLY output the structured summary.`;

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

export function computeFileLists(fileOps: FileOperations): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();

	return { readFiles: readOnly, modifiedFiles };
}

function filePathOf(args: Record<string, unknown> | undefined): string | undefined {
	if (typeof args?.path === "string") return args.path;
	if (typeof args?.file_path === "string") return args.file_path;

	return undefined;
}

function addFileOp(
	toolName: string,
	args: Record<string, unknown> | undefined,
	fileOps: FileOperations,
): void {
	const path = filePathOf(args);
	if (!path) return;

	switch (toolName) {
		case "read":
			fileOps.read.add(path);
			break;
		case "write":
			fileOps.written.add(path);
			break;
		case "edit":
			fileOps.edited.add(path);
			break;
	}
}

function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	let end = Math.max(0, maxChars);
	const last = text.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;

	const truncatedChars = text.length - end;
	return `${text.slice(0, end)}\n\n[... ${truncatedChars} more characters truncated]`;
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const lines = [
		...modifiedFiles.map((file) => `- ${file} (edited)`),
		...readFiles.map((file) => `- ${file} (read)`),
	];

	if (lines.length === 0) return "";
	return `\n\n## Files\n${lines.join("\n")}`;
}

export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role === "toolResult") {
		for (const call of message.nestedCalls?.calls ?? []) {
			addFileOp(call.name, call.arguments, fileOps);
		}
		return;
	}

	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;
		addFileOp(block.name, block.arguments as Record<string, unknown> | undefined, fileOps);
	}
}

type AssistantContent = Extract<Message, { role: "assistant" }>["content"];

function assistantParts(content: AssistantContent): string[] {
	const parts: string[] = [];
	const toolCalls: string[] = [];

	for (const block of content) {
		if (block.type !== "toolCall") continue;

		const args = block.arguments as Record<string, unknown>;
		const argsText = Object.entries(args)
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join(", ");
		toolCalls.push(`${block.name}(${argsText})`);
	}

	if (content.some((block) => block.type === "text")) {
		parts.push(`[Assistant]: ${contentText(content)}`);
	}

	if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);

	return parts;
}

export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const message of messages) {
		if (message.role === "user") {
			const content = contentText(message.content, "");
			if (content) parts.push(`[User]: ${content}`);
			continue;
		}

		if (message.role === "assistant") {
			parts.push(...assistantParts(message.content));
			continue;
		}

		if (message.role === "toolResult") {
			const content = contentText(message.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}
