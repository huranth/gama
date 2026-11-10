import type { Usage } from "@huranth/gama-ai";
import { copyJson, type Draft, type JsonRepresentation } from "@huranth/gama-bus";
import { defineDoc } from "../docs.ts";
import type { ConversationId, Tx } from "../types.ts";

export type UsageState = {
	models: Record<string, JsonRepresentation<Usage>>;
	tools: Record<string, JsonRepresentation<Usage>>;
};

export const UsageDoc = defineDoc<UsageState>({
	kind: "gama.usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});

const COUNTER_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	const totals = (await tx.doc(UsageDoc, conversationId))[bucket];
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	if (total === undefined) {
		const copy = copyJson(usage, { omitUndefinedProperties: true });
		totals[key] = copy as JsonRepresentation<Usage>;
	} else {
		addUsage(total, usage);
	}
}

export function addUsage(total: Draft<Usage> | Usage, usage: Usage): void {
	for (const key of COUNTER_KEYS) {
		total[key] += usage[key];
	}

	for (const key of COST_KEYS) {
		total.cost[key] += usage.cost[key];
	}

	if (usage.cacheWrite1h !== undefined) {
		total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	}

	if (usage.reasoning !== undefined) {
		total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	}
}

export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		for (const [key, usage] of Object.entries(state[bucket])) {
			const existing = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;

			if (existing !== undefined) {
				addUsage(existing, usage);
				continue;
			}

			Object.defineProperty(sum[bucket], key, {
				value: structuredClone(usage),
				enumerable: true,
				writable: true,
			});
		}
	}
}
