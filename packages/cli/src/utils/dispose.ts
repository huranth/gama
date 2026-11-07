export const DISPOSE_TIMEOUT_MS = 5_000;

export async function disposeWithTimeout(
	dispose: () => Promise<void>,
	timeoutMs = DISPOSE_TIMEOUT_MS,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timedOut = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});

	const finished = (async () => {
		try {
			await dispose();
			return true;
		} catch {
			return false;
		}
	})();

	try {
		return await Promise.race([finished, timedOut]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
