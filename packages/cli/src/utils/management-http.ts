type FetchInput = Parameters<typeof fetch>[0];

export interface FetchRetryOptions {
	maxRetries?: number;
	retryOnStatus?: boolean;
	timeoutMs?: number;
	attemptTimeoutMs?: number;
}

const retryableStatusCodes = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultMaxRetries = 2;

function toCount(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function positiveOrUndefined(value: number | undefined): number | undefined {
	if (value === undefined || value <= 0) return undefined;
	return value;
}

export async function fetchWithRetry(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
): Promise<Response> {
	const maxRetries = toCount(options.maxRetries, defaultMaxRetries);
	const retryOnStatus = options.retryOnStatus ?? true;

	const parentSignal = init?.signal ?? undefined;
	const timeoutMs = positiveOrUndefined(options.timeoutMs);
	const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
	const attemptTimeoutMs = positiveOrUndefined(options.attemptTimeoutMs);

	for (let attempt = 0; ; attempt++) {
		parentSignal?.throwIfAborted();
		timeoutSignal?.throwIfAborted();

		const attemptTimeoutSignal =
			attemptTimeoutMs === undefined ? undefined : AbortSignal.timeout(attemptTimeoutMs);
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

		try {
			const response = await fetch(input, signal ? { ...init, signal } : init);

			const isRetryable =
				retryOnStatus && retryableStatusCodes.has(response.status) && attempt < maxRetries;
			if (!isRetryable) return response;

			try {
				await response.body?.cancel();
			} catch {}
		} catch (error) {
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true &&
				!parentSignal?.aborted &&
				!timeoutSignal?.aborted;

			const callerAborted = parentSignal?.aborted === true;
			const deadlineHit = timeoutSignal?.aborted === true;
			const attemptAborted =
				error instanceof Error &&
				error.name === "AbortError" &&
				!attemptTimedOut &&
				timeoutSignal === undefined;
			const outOfRetries = attempt >= maxRetries;

			if (callerAborted || deadlineHit || attemptAborted || outOfRetries) {
				throw error;
			}
		}
	}
}
