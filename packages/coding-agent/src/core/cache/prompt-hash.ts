import { createHash } from "node:crypto";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Tool,
} from "@huranth/gama-ai";
import type { SessionEntry } from "../session-manager.ts";

export interface PromptCacheFingerprint {
	full: string;
	prefix: string | undefined;
	messageCount: number;
}

export interface PriorPromptCache {
	hash: string;
	messageCount: number;
}

export type MessageLike = { role: string };

const VOLATILE_FIELDS = new Set([
	"timestamp",
	"usage",
	"cost",
	"diagnostics",
	"inputTokensDetails",
]);

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function serialize(serialized: readonly string[]): string {
	return sha256(serialized.join("\n"));
}

export function promptTokensOf(message: AssistantMessage): number {
	const { usage } = message;
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function withPromptCacheStamping(
	source: AssistantMessageEventStream,
	fingerprint: PromptCacheFingerprint,
): AssistantMessageEventStream {
	const target = createAssistantMessageEventStream();

	void (async () => {
		try {
			for await (const event of source) {
				target.push(stampEvent(event, fingerprint));
			}
		} catch {
			// End stream
			target.end();
			return;
		}

		// Close first
		target.end();
		// Forward result
		await source.result().then(
			(message) => target.end(message),
			() => {},
		);
	})();

	return target;
}

function stampEvent(
	event: AssistantMessageEvent,
	fingerprint: PromptCacheFingerprint,
): AssistantMessageEvent {
	if (event.type === "done" || event.type === "error") {
		const message = event.type === "done" ? event.message : event.error;
		message.promptHash = fingerprint.full;
		message.promptPrefixHash = fingerprint.prefix;
		message.promptMessages = fingerprint.messageCount;
	}

	return event;
}

function serializeMessage(message: MessageLike): string {
	switch (message.role) {
		case "system":
		case "user": {
			return `${message.role}|${serializeText(message)}`;
		}
		case "assistant": {
			const assistant = message as { thinkingLevel?: string | undefined };
			if (assistant.thinkingLevel)
				return `assistant|${assistant.thinkingLevel}|${serializeText(message)}`;
			return `assistant|${serializeText(message)}`;
		}
		case "toolResult": {
			const toolResult = message as {
				toolCallId?: string;
				toolName?: string;
				isError?: boolean;
			};
			const toolCallId = toolResult.toolCallId ?? "";
			const toolName = toolResult.toolName ?? "";
			const isError = String(toolResult.isError === true);
			return `toolResult|${toolCallId}|${toolName}|${isError}|${serializeText(message)}`;
		}
		default: {
			return `${message.role}|${canonical(message)}`;
		}
	}
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return typeof value === "string" ? `s:${value}` : (JSON.stringify(value) ?? "u");
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join("|")}]`;
	}

	const entries = Object.entries(value as Record<string, unknown>).filter(
		([key, stored]) => !VOLATILE_FIELDS.has(key) && stored !== undefined,
	);

	entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

	return `{${entries.map(([key, stored]) => `${key}:${canonical(stored)}`).join(",")}}`;
}

export function fingerprintPrompt(input: {
	systemPrompt?: string;
	tools?: readonly Tool[];
	messages: readonly MessageLike[];
	prior?: PriorPromptCache;
}): PromptCacheFingerprint {
	const head: string[] = [];

	if (input.systemPrompt) head.push(`systemPrompt|${input.systemPrompt}`);
	if (input.tools && input.tools.length > 0) head.push(`tools|${canonical(input.tools)}`);

	const serialized = [...head, ...input.messages.map(serializeMessage)];
	const messageCount = input.messages.length;

	let prefix: string | undefined;
	if (input.prior && input.prior.messageCount <= messageCount) {
		prefix = serialize(serialized.slice(0, head.length + input.prior.messageCount));
	}

	return { full: serialize(serialized), prefix, messageCount };
}

export function priorPromptCacheOf(entries: readonly SessionEntry[]): PriorPromptCache | undefined {
	for (const entry of reverse(entries)) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const message = entry.message as AssistantMessage;

		// Stamped chain
		if (message.promptHash !== undefined && message.promptMessages !== undefined) {
			return { hash: message.promptHash, messageCount: message.promptMessages };
		}
		if (promptTokensOf(message) > 0 || message.usage.output > 0) return undefined;
	}

	return undefined;
}

function* reverse(entries: readonly SessionEntry[]): Iterable<SessionEntry> {
	for (let index = entries.length - 1; index >= 0; index--) {
		yield entries[index];
	}
}

function serializeText(message: MessageLike): string {
	const { content } = message as { content?: unknown };
	if (typeof content === "string") return `t:${content}`;
	if (!Array.isArray(content)) return `j:${canonical(content)}`;

	const parts = content
		.map((part): string => {
			if (typeof part === "string") return `t:${part}`;
			const item = part as { type?: string };
			if (item.type === "text") {
				return `t:${(part as { text?: string }).text ?? ""}`;
			}
			if (item.type === "image") {
				const image = part as { mimeType?: string; data?: string };
				return `i:${image.mimeType ?? ""}:${image.data ?? ""}`;
			}
			if (item.type === "thinking") {
				return `h:${(part as { thinking?: string }).thinking ?? ""}`;
			}
			if (item.type === "toolCall") {
				const call = part as { id?: string; name?: string; arguments?: unknown };
				return `c:${call.id ?? ""}:${call.name ?? ""}:${canonical(call.arguments)}`;
			}
			return `p:${canonical(part)}`;
		})
		.join("|");

	return parts;
}
