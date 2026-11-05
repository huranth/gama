export type DocumentationVariant = (typeof DOCUMENTATION_VARIANTS)[number];

export type DiscoveredEvalCase = {
	file: string;
	fullName: string;
	evalSet: string;
	caseId: string;
};

export type EvalTask = DiscoveredEvalCase & {
	variant: DocumentationVariant;
	model: string;
	runNumber: number;
};

export const DOCUMENTATION_VARIANTS = ["without_docs", "with_docs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDiscoveredCases(value: unknown): DiscoveredEvalCase[] {
	if (!Array.isArray(value)) throw new TypeError("Discovered eval cases must be an array.");
	const identities = new Set<string>();
	return value.map((item) => {
		if (!isRecord(item) || typeof item.name !== "string" || typeof item.file !== "string") {
			throw new TypeError("Discovered eval case is invalid.");
		}
		const [rawEvalSet, rawCaseId, ...extra] = item.name.split(" > ");
		const evalSet = rawEvalSet?.trim();
		const caseId = rawCaseId?.trim();
		if (!evalSet || !caseId || extra.length > 0) {
			throw new TypeError(`Documentation eval must use "<eval set> > <case>": ${item.name}`);
		}
		const identity = JSON.stringify([evalSet, caseId]);
		if (identities.has(identity)) {
			throw new TypeError(`Duplicate eval case identity: ${item.name}`);
		}
		identities.add(identity);
		return { file: item.file, fullName: item.name, evalSet, caseId };
	});
}

export function createTaskPlan(
	cases: readonly DiscoveredEvalCase[],
	model: string,
	runsPerVariant: number,
): EvalTask[] {
	if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) {
		throw new TypeError("Model identity must contain a provider and model.");
	}
	if (!Number.isSafeInteger(runsPerVariant) || runsPerVariant < 1) {
		throw new TypeError("Runs per variant must be a positive integer.");
	}
	const tasks: EvalTask[] = [];
	for (const evalCase of cases) {
		for (let runNumber = 1; runNumber <= runsPerVariant; runNumber += 1) {
			const ordered: DocumentationVariant[] = [...DOCUMENTATION_VARIANTS];
			const variants = runNumber % 2 === 1 ? ordered : ordered.reverse();

			for (const variant of variants) {
				tasks.push({ ...evalCase, variant, model, runNumber });
			}
		}
	}
	return tasks;
}
