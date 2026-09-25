import type { CacheRetention, ModelCost } from "@huranth/gama-ai";
import type { Usage } from "@huranth/gama-ai/compat";
import { promptTokens } from "./rate.ts";

export interface CacheHealthInput {
	usages: readonly Usage[];
	cost: Pick<ModelCost, "input" | "cacheRead" | "cacheWrite">;
	retention?: CacheRetention;
}

export interface CacheHealth {
	status: "ok" | "cold" | "no-cache";
	requests: number;
	message?: string;
}

const MIN_REQUESTS = 3;

const MIN_CACHEABLE_PROMPT_TOKENS = 1024;

function hasCachePricing(cost: CacheHealthInput["cost"]): boolean {
	const readDiscounted = cost.cacheRead > 0 && cost.cacheRead < cost.input;
	const writePriced = cost.cacheWrite > 0 && cost.cacheWrite > cost.input;

	return readDiscounted || writePriced;
}

export function assessCacheHealth(input: CacheHealthInput): CacheHealth {
	const measured = input.usages.filter((usage) => promptTokens(usage) > 0);
	const requests = measured.length;

	if (input.retention === "none") return { status: "no-cache", requests };
	if (!hasCachePricing(input.cost)) return { status: "no-cache", requests };

	if (requests < MIN_REQUESTS) return { status: "ok", requests };
	if (measured.some((usage) => usage.cacheRead > 0)) return { status: "ok", requests };

	const maxPrompt = Math.max(...measured.map(promptTokens));
	if (maxPrompt < MIN_CACHEABLE_PROMPT_TOKENS) return { status: "ok", requests };

	return { status: "cold", requests, message: "No cache hits" };
}
