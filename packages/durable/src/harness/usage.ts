import { copyJson, type Draft, type JsonRepresentation } from "@huranth/chord";
import type { Usage } from "@huranth/gama-ai";
import { defineDoc } from "../documents.ts";
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
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) {
		total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	}
	if (usage.reasoning !== undefined) {
		total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	}
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
			if (total !== undefined) {
				addUsage(total, usage);
			} else {
				Object.defineProperty(sum[bucket], key, {
					value: structuredClone(usage),
					enumerable: true,
					writable: true,
				});
			}
		}
	}
}
