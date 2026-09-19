import type { ThinkingLevel } from "@huranth/gama-agent-core";

export interface ReasoningLevelPreset {
	tier: ThinkingLevel;
	name: string;
	hint: string;
}

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const REASONING_LEVELS: readonly ReasoningLevelPreset[] = [
	{ tier: "off", name: "parked", hint: "Reasoning off, one-shot responses" },
	{ tier: "minimal", name: "idling", hint: "Engine running, a quick thought when needed" },
	{ tier: "low", name: "cruising", hint: "Coasting on autopilot, light reasoning" },
	{ tier: "medium", name: "steady", hint: "Balanced pace, standard mode" },
	{ tier: "high", name: "pushing", hint: "Leaning on it, deliberate reasoning" },
	{ tier: "xhigh", name: "overdrive", hint: "Extra gear, extended deliberation" },
	{ tier: "max", name: "redline", hint: "Full throttle, maximum deliberation" },
];

export function reasoningLevelName(tier: string): string {
	return REASONING_LEVELS.find((level) => level.tier === tier)?.name ?? tier;
}

export function reasoningLevelTier(name: string): ThinkingLevel | undefined {
	const entry = REASONING_LEVELS.find(
		(level) => level.name.toLowerCase() === name.toLowerCase().trim(),
	);
	return entry?.tier;
}
