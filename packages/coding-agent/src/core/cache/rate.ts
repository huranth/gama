import type { Usage } from "@huranth/gama-ai/compat";

export interface CacheRateTier {
	inputTokensAbove: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface CacheRates {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: readonly CacheRateTier[];
}

export interface CacheTurn {
	usage: Usage;
	rates?: CacheRates;
}

export interface CacheTotals {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	prompt: number;
	hit: number;
	spent: number;
	uncached: number;
	saved: number;
}

export interface NextCostInput {
	rates: CacheRates;
	prompt: number;
	output: number;
	outputRate: number;
	added: number;
	warm: boolean;
}

const TOKENS_PER_MILLION = 1_000_000;

export function promptTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function hitRate(usage: Usage): number {
	const prompt = promptTokens(usage);
	if (prompt === 0) return 0;
	return usage.cacheRead / prompt;
}

// Tier lookup.
function priceFor(rates: CacheRates, prompt: number): CacheRateTier | CacheRates {
	let selected: CacheRateTier | CacheRates = rates;
	let best = -1;

	for (const tier of rates.tiers ?? []) {
		if (prompt <= tier.inputTokensAbove) continue;
		if (tier.inputTokensAbove < best) continue;
		selected = tier;
		best = tier.inputTokensAbove;
	}

	return selected;
}

// Cost billed.
export function billedCost(usage: Usage, rates?: CacheRates): number {
	if (!rates) {
		return usage.cost.input + usage.cost.cacheRead + usage.cost.cacheWrite;
	}

	const price = priceFor(rates, promptTokens(usage));
	const longWrite = Math.min(usage.cacheWrite, usage.cacheWrite1h ?? 0);
	const shortWrite = usage.cacheWrite - longWrite;
	const tokens =
		usage.input * price.input +
		usage.cacheRead * price.cacheRead +
		shortWrite * price.cacheWrite +
		longWrite * price.input * 2;

	return tokens / TOKENS_PER_MILLION;
}

// Uncached cost.
export function uncachedCost(usage: Usage, rates?: CacheRates): number {
	if (!rates) return billedCost(usage);

	const price = priceFor(rates, promptTokens(usage));
	const tokens = promptTokens(usage) * price.input;

	return tokens / TOKENS_PER_MILLION;
}

export function savedCost(usage: Usage, rates?: CacheRates): number {
	const spent = billedCost(usage, rates);
	const uncached = uncachedCost(usage, rates);

	return Math.max(0, uncached - spent);
}

export function projectCost(input: NextCostInput): number {
	const { rates, prompt, output, outputRate, added, warm } = input;
	const price = priceFor(rates, prompt + added);
	const spoken = output * outputRate;
	const promptRate = warm ? price.cacheRead : price.cacheWrite;
	const freshRate = warm ? price.input : price.cacheWrite;
	const tokens = prompt * promptRate + added * freshRate + spoken;

	return tokens / TOKENS_PER_MILLION;
}

export function cacheTotals(turns: readonly CacheTurn[]): CacheTotals {
	const totals: CacheTotals = {
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0,
		prompt: 0,
		hit: 0,
		spent: 0,
		uncached: 0,
		saved: 0,
	};

	for (const turn of turns) {
		const { usage } = turn;
		totals.input += usage.input;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
		totals.output += usage.output;
		totals.spent += billedCost(usage, turn.rates);
		totals.uncached += uncachedCost(usage, turn.rates);
	}

	totals.prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	totals.hit = totals.prompt === 0 ? 0 : totals.cacheRead / totals.prompt;
	totals.saved = Math.max(0, totals.uncached - totals.spent);

	return totals;
}
