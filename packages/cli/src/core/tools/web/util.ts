// Number repair
export function repairNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;

	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	if (Array.isArray(value) && value.length === 1) return repairNumber(value[0]);

	return undefined;
}

// Abortable sleep
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Cancelled"));

		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Cancelled"));
		};

		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
