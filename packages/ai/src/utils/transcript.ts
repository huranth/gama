import type {
	Context,
	Message,
	SystemMessage,
	Tool,
	ToolReference,
	TranscriptContext,
} from "../types.ts";
import { contentText, getSystemMessageText } from "./text.ts";

export type { TranscriptContext } from "../types.ts";

export type TranscriptMessages = readonly { role: string }[];

export interface ToolStateChanges {
	toolsAdded: Tool[];
	toolsRemoved: ToolReference[];
}

export interface TranscriptTools {
	requestTools: Tool[];
	anchorsAdditions: boolean;
}

export function normalizeContext(context: Context): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages } as TranscriptContext;
}

function isSystemMessage(message: { role: string }): message is SystemMessage {
	return message.role === "system";
}

export function withoutInitialSystemMessage(messages: Message[]): Message[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : messages;
}

export function getCurrentSystemPrompt(messages: TranscriptMessages): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}

export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const messages = context.messages.filter((message) => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages } as TranscriptContext;
}

export function resolveTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined
			? {}
			: { constrainedSampling: tool.constrainedSampling }),
	};
}

export function declarationsEqual(left: Tool, right: Tool): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export function getInitialSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const first = messages[0];
	return first && isSystemMessage(first) ? first : undefined;
}

export function getToolStateChanges(
	previous: readonly Tool[],
	current: readonly Tool[],
): ToolStateChanges {
	const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
	const currentTools = new Map(current.map((tool) => [tool.name, tool]));
	const toolsAdded: Tool[] = [];
	const toolsRemoved: ToolReference[] = [];

	for (const tool of current) {
		const previousTool = previousTools.get(tool.name);
		if (previousTool === undefined || !declarationsEqual(previousTool, tool)) {
			toolsAdded.push(toToolDeclaration(tool));
		}
	}

	for (const tool of previous) {
		const currentTool = currentTools.get(tool.name);
		if (currentTool === undefined || !declarationsEqual(tool, currentTool)) {
			toolsRemoved.push({ name: tool.name });
		}
	}

	return { toolsAdded, toolsRemoved };
}

export function resolveTranscriptTools(
	messages: TranscriptMessages,
	supportsToolAdditions: boolean,
): TranscriptTools {
	const anchorsAdditions = supportsToolAdditions && !hasNonAdditiveToolChanges(messages);
	return {
		requestTools: anchorsAdditions
			? (getInitialSystemMessage(messages)?.toolsAdded ?? [])
			: getCurrentTools(messages),
		anchorsAdditions,
	};
}

export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: Tool[] | undefined,
): SystemMessage | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};
}

export function getDeclaredTools(messages: TranscriptMessages): Tool[] {
	const definitions = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) {
			definitions.set(tool.name, tool);
		}
	}
	return [...definitions.values()];
}

export function hasToolRedefinitions(messages: TranscriptMessages): boolean {
	const declared = new Map<string, Tool>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) {
			const previous = declared.get(tool.name);
			if (previous !== undefined && !declarationsEqual(previous, tool)) return true;
			declared.set(tool.name, tool);
		}
	}
	return false;
}

export function hasNonAdditiveToolChanges(messages: TranscriptMessages): boolean {
	const declared = new Set<string>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		if ((message.toolsRemoved?.length ?? 0) > 0) return true;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name)) return true;
			declared.add(tool.name);
		}
	}
	return false;
}

export function getCurrentTools(messages: TranscriptMessages): Tool[] {
	const tools = new Map<string, Tool | null>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;

		const removed = new Set((message.toolsRemoved ?? []).map((tool) => tool.name));
		if (removed.size > 0) {
			const onlyRemovedLeft = [...tools].every(
				([name, tool]) => tool === null || removed.has(name),
			);
			if (onlyRemovedLeft) tools.clear();
		}

		for (const name of removed) {
			if (tools.has(name)) tools.set(name, null);
		}

		for (const tool of message.toolsAdded ?? []) {
			tools.set(tool.name, tool);
		}
	}
	return [...tools.values()].filter((tool): tool is Tool => tool !== null);
}

export function getCurrentSystemMessage(messages: TranscriptMessages): SystemMessage | undefined {
	const content: string[] = [];
	const sections = new Map<string, string | null>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;

		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);

		const patches = Object.entries(message.sections ?? {});
		const removed = new Set(patches.filter(([, value]) => value === null).map(([name]) => name));
		if (
			removed.size > 0 &&
			[...sections].every(([name, value]) => value === null || removed.has(name))
		) {
			sections.clear();
		}

		for (const [name, value] of patches) {
			if (value !== null || sections.has(name)) sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	const activeSections = [...sections].filter(
		(entry): entry is [string, string] => entry[1] !== null,
	);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(activeSections.length > 0 ? { sections: Object.fromEntries(activeSections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}
