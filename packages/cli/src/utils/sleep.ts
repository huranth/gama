const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function abortedError(): Error {
	return new Error("Aborted");
}

export function sleepSync(ms: number): void {
	Atomics.wait(sleepBuffer, 0, 0, ms);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortedError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortedError());
		};

		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
