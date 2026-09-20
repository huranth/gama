import type { ThinkingLevel } from "@huranth/gama-agent-core";
import type { Model } from "@huranth/gama-ai/compat";
import { modelsAreEqual } from "@huranth/gama-ai/compat";

export interface ModelCandidate {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

export function pickNextModel(
	candidates: ModelCandidate[],
	current: Model<any> | undefined,
	direction: "forward" | "backward",
): ModelCandidate | undefined {
	if (candidates.length <= 1) {
		return undefined;
	}

	const index = candidates.findIndex((candidate) => modelsAreEqual(candidate.model, current));

	if (index === -1) {
		const first = candidates[0];
		const last = candidates[candidates.length - 1];

		return direction === "forward" ? first : last;
	}

	const step = direction === "forward" ? 1 : -1;
	const next = (index + step + candidates.length) % candidates.length;

	return candidates[next];
}
