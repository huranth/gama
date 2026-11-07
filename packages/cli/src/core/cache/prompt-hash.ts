import { createHash } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type ReplyStream,
	createReplyStream,
	type Model,
	type Tool,
} from "@huranth/gama-ai";
import type { SessionEntry } from "../sessions.ts";
import { hasReportedUsage } from "./rate.ts";

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

const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function hashParts(parts: readonly string[]): string {
	return sha256(parts.join("\n"));
}

export function withPromptCacheStamping(
	source: ReplyStream,
	fingerprint: PromptCacheFingerprint,
	model: Model<Api>,
): ReplyStream {
	const target = createReplyStream();
	let partial: AssistantMessage | undefined;

	const forward = async (): Promise<void> => {
		try {
			for await (const event of source) {
				if ("partial" in event) partial = event.partial;
				target.push(stampEvent(event, fingerprint));
			}
		} catch (error) {
			// Source broke
			void source.result().catch(() => {});
			endWithError(target, failureMessage(error, partial, model, fingerprint));
			return;
		}

		await source.result().then(
			(message) => endStream(target, message),
			(error) => endWithError(target, failureMessage(error, partial, model, fingerprint)),
		);
	};

	// Never reject
	void forward().catch((error) => {
		endWithError(target, failureMessage(error, partial, model, fingerprint));
	});

	return target;
}

function endStream(target: ReplyStream, message?: AssistantMessage): void {
	target.end(message);

	// Observed rejection.
	void target.result().catch(() => {});
}

function endWithError(target: ReplyStream, message: AssistantMessage): void {
	target.push({ type: "error", reason: "error", error: message });
	endStream(target, message);
}

function failureMessage(
	error: unknown,
	partial: AssistantMessage | undefined,
	model: Model<Api>,
	fingerprint: PromptCacheFingerprint,
): AssistantMessage {
	const reason = error instanceof Error ? error.message : String(error);
	const base: AssistantMessage = partial ?? {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "error",
		timestamp: Date.now(),
	};

	return stampMessage({ ...base, stopReason: "error", errorMessage: reason }, fingerprint);
}

function stampEvent(
	event: AssistantMessageEvent,
	fingerprint: PromptCacheFingerprint,
): AssistantMessageEvent {
	if (event.type === "done" || event.type === "error") {
		stampMessage(event.type === "done" ? event.message : event.error, fingerprint);
	}

	return event;
}

function stampMessage(
	message: AssistantMessage,
	fingerprint: PromptCacheFingerprint,
): AssistantMessage {
	message.promptHash = fingerprint.full;
	message.promptPrefixHash = fingerprint.prefix;
	message.promptMessages = fingerprint.messageCount;

	return message;
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
		prefix = hashParts(serialized.slice(0, head.length + input.prior.messageCount));
	}

	return { full: hashParts(serialized), prefix, messageCount };
}

export function priorPromptCacheOf(entries: readonly SessionEntry[]): PriorPromptCache | undefined {
	for (const entry of reverse(entries)) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const message = entry.message as AssistantMessage;

		// Stamped chain
		if (message.promptHash !== undefined && message.promptMessages !== undefined) {
			return { hash: message.promptHash, messageCount: message.promptMessages };
		}
		if (hasReportedUsage(message.usage)) return undefined;
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
