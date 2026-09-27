interface TimingNamespace {
	timings: Array<{ label: string; ms: number }>;
	lastTime: number;
}

type TimingLabel = "main" | "extensions";

const ENABLED = process.env.GAMA_TIMING === "1";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	timingNamespaces.set(namespace, { timings: [], lastTime: Date.now() });
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace);
	if (!timingNamespace) return;
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;

	let total = 0;
	console.error(`\n--- ${title} ---`);

	for (const timing of printableTimings) {
		total += timing.ms;
		console.error(`  ${timing.label}: ${timing.ms}ms`);
	}

	console.error(`  TOTAL: ${total}ms`);
	console.error(`${"-".repeat(title.length + 8)}\n`);
}
