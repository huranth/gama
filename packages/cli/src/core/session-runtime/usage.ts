import type { AgentMessage } from "@huranth/gama-agent-core";
import type { CacheRetention, Model, ModelCost } from "@huranth/gama-ai";
import type { AssistantMessage } from "@huranth/gama-ai/compat";
import { assessCacheHealth, type CacheHealth } from "../cache/index.ts";
import { estimateTokens } from "../comp/index.ts";
import type { SessionEntry } from "../sessions.ts";

export const FREE_COST = { input: 0, cacheRead: 0, cacheWrite: 0 };

export type CacheCost = Pick<ModelCost, "input" | "cacheRead" | "cacheWrite">;

export interface CacheHealthContext {
	cost: CacheCost | undefined;
	retention: CacheRetention | undefined;
	resolveModel(provider: string, modelId: string): Model<any> | undefined;
}

export interface PromptSummaryUsageContext {
	isStreaming: boolean;
	isCompacting: boolean;
	waitForIdle(): Promise<void>;
	appendUsage(response: AssistantMessage): void;
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

export function getLastAssistantText(messages: readonly AgentMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((message) => {
			if (message.role !== "assistant") return false;
			const assistant = message as AssistantMessage;
			if (assistant.stopReason === "aborted" && assistant.content.length === 0) return false;
			return true;
		});

	if (!lastAssistant) return undefined;

	let text = "";
	for (const content of (lastAssistant as AssistantMessage).content) {
		if (content.type === "text") {
			text += content.text;
		}
	}

	return text.trim() || undefined;
}

export function collectAssistantMessages(entries: readonly SessionEntry[]): AssistantMessage[] {
	const messages: AssistantMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		messages.push(entry.message);
	}
	return messages;
}

export function buildCacheHealth(
	entries: readonly SessionEntry[],
	context: CacheHealthContext,
): CacheHealth {
	const messages = collectAssistantMessages(entries);
	const fallbackCost = context.cost ?? FREE_COST;
	const latest = messages.at(-1);

	if (!latest) {
		return assessCacheHealth({
			usages: [],
			cost: fallbackCost,
			retention: context.retention,
		});
	}

	const provider = latest.provider;
	const modelId = latest.responseModel ?? latest.model;
	const usages = messages
		.filter((message) => message.provider === provider)
		.filter((message) => (message.responseModel ?? message.model) === modelId)
		.map((message) => message.usage);
	const model = context.resolveModel(provider, modelId);

	return assessCacheHealth({
		usages,
		cost: model?.cost ?? fallbackCost,
		retention: context.retention,
	});
}

export function recordPromptSummaryUsage(
	context: PromptSummaryUsageContext,
	response: AssistantMessage,
): void {
	const record = () => {
		try {
			context.appendUsage(response);
		} catch {
			// Best effort
		}
	};

	if (context.isStreaming || context.isCompacting) {
		void context
			.waitForIdle()
			.then(record)
			.catch(() => undefined);
		return;
	}

	record();
}
