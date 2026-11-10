interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

function normalizeRetryCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;

	return Math.max(0, Math.floor(value));
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";

	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};

		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) {
		return false;
	}

	const hasValidStatus = error.status === undefined || typeof error.status === "number";
	const hasValidHeaders = error.headers === undefined || error.headers instanceof Headers;

	return hasValidStatus && hasValidHeaders;
}

function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");

	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;
	if (error.status === undefined) return true;

	return (
		error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
	);
}

function getRetryDelayMs(
	error: ProviderError,
	retryIndex: number,
	maxRetryDelayMs: number | undefined,
): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");

	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);

		if (Number.isFinite(value) && value >= 0) {
			return validateServerRetryDelayMs(value, maxRetryDelayMs);
		}
	}

	const retryAfter = error.headers?.get("retry-after");

	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;

		if (Number.isFinite(delayMs) && delayMs > 0) {
			return validateServerRetryDelayMs(delayMs, maxRetryDelayMs);
		}
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	const jitter = 1 - Math.random() * 0.25;

	return exponentialDelay * jitter;
}

function validateServerRetryDelayMs(delayMs: number, maxRetryDelayMs: number | undefined): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		const requestedSeconds = Math.ceil(delayMs / 1000);
		const maxSeconds = Math.ceil(maxDelayMs / 1000);

		throw new Error(`Delay too long: ${requestedSeconds}s (max: ${maxSeconds}s)`);
	}

	return delayMs;
}

export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = normalizeRetryCount(options.maxRetries);
	let retriesRemaining = maxRetries;

	for (;;) {
		if (options.signal?.aborted) throw createAbortError();

		try {
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();

			const retryableError = isProviderError(error) && isRetryableProviderError(error);
			const canRetry = retriesRemaining > 0 && retryableError;

			if (!canRetry) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;

			const delayMs = getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs);
			await abortableSleep(delayMs, options.signal);
		}
	}
}
