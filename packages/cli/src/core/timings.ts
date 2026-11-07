interface TimingNamespace {
	timings: Array<{ label: string; ms: number }>;
	lastTime: number;
}

type TimingLabel = "main" | "extensions";

const TIMING_ENV = "GAMA_TIMING";

const DIVIDER_PAD = 8;

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!isEnabled()) return;

	const bucket = { timings: [], lastTime: Date.now() };
	timingNamespaces.set(namespace, bucket);
}

export function printTimings(): void {
	if (!isEnabled()) return;

	for (const [name, bucket] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${name}`, bucket.timings);
	}
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!isEnabled()) return;

	const now = Date.now();
	const bucket = ensureNamespace(namespace);

	bucket.timings.push({ label, ms: now - bucket.lastTime });
	bucket.lastTime = now;
}

function isEnabled(): boolean {
	return process.env[TIMING_ENV] === "1";
}

function ensureNamespace(namespace: TimingLabel): TimingNamespace {
	const existing = timingNamespaces.get(namespace);
	if (existing) return existing;

	const bucket = { timings: [], lastTime: Date.now() };
	timingNamespaces.set(namespace, bucket);

	return bucket;
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
	console.error(`${"-".repeat(title.length + DIVIDER_PAD)}\n`);
}
