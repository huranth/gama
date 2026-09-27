import type { Usage } from "@huranth/gama-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usageTotalCost(usage);
}

export function combineUsage(first: Usage, second: Usage): Usage {
	const cacheWrite1h = sumOptional(first.cacheWrite1h, second.cacheWrite1h);
	const reasoning = sumOptional(first.reasoning, second.reasoning);

	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: usageTotalCost(first) + usageTotalCost(second),
		},
	};
}

export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		const read = readUsageEntry(entry);
		if (!read) continue;

		let totals = totalsByKey.get(read.key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(read.key, totals);
		}

		addUsageToTotals(totals, read.usage);
	}

	const breakdown = Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}));
	const visible = breakdown.filter((entry) => entry.cost > 0 || entry.tokens > 0);

	return visible.sort((a, b) => b.cost - a.cost);
}

function readUsageEntry(entry: SessionEntry): { key: string; usage: Usage } | undefined {
	if (entry.type === "usage") {
		return { key: `${entry.provider}/${entry.model}`, usage: entry.usage };
	}

	if (entry.type === "branch_summary" || entry.type === "compaction") {
		if (!entry.usage) return undefined;

		return { key: "Tools/summaries", usage: entry.usage };
	}

	if (entry.type !== "message") return undefined;

	const message = entry.message;
	if (message.role === "assistant") {
		const model = message.responseModel ?? message.model;

		return { key: `${message.provider}/${model}`, usage: message.usage };
	}

	if (message.role === "toolResult" && message.usage) {
		return { key: "Tools/summaries", usage: message.usage };
	}

	return undefined;
}

function sumOptional(first: number | undefined, second: number | undefined): number | undefined {
	if (first === undefined && second === undefined) return undefined;

	return (first ?? 0) + (second ?? 0);
}

// Optional cost.
function usageTotalCost(usage: Usage): number {
	const total = usage.cost?.total;

	return Number.isFinite(total) ? total : 0;
}
