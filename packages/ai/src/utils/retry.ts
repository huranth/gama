import type { AssistantMessage } from "../types.ts";

export interface RetryPolicy {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs?: number;
}

export interface RetryCallbacks {
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	onRetryAttemptStart?: () => void | Promise<void>;
	onRetryFinished?: (
		success: boolean,
		attempt: number,
		finalError?: string,
	) => void | Promise<void>;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
	"subscription_sharing_usage_limit_exceeded",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNRESET",
	"ETIMEDOUT",
	"premature close",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",
	"websocket.?closed",
	"websocket.?error",
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	"retry delay",
	"you can retry your request",
	"try your request again",
	"please retry your request",
	"ResourceExhausted",
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

export function retryDelayMs(
	policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">,
	attempt: number,
): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	const maxDelayMs = policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS;

	return Math.min(safeDelay, maxDelayMs);
}

export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;

	const errorMessage = message.errorMessage;

	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;

	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;

	const finish = async (success: boolean, errorMessage?: string) => {
		if (!lastRetry) return;

		if (errorMessage === undefined) {
			await callbacks?.onRetryFinished?.(success, lastRetry.attempt);
			return;
		}

		await callbacks?.onRetryFinished?.(success, lastRetry.attempt, errorMessage);
	};

	for (;;) {
		const response = await produce();

		if (response.stopReason === "aborted") {
			await finish(false);

			return response;
		}

		if (response.stopReason !== "error") {
			await finish(true);

			return response;
		}

		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			await finish(false, response.errorMessage);

			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };

		const delayMs = retryDelayMs(policy!, attempt);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await finish(false, lastRetry.errorMessage);

			if (error instanceof RetrySleepAbortError) {
				const { errorMessage: _errorMessage, ...rest } = response;

				return { ...rest, stopReason: "aborted" };
			}

			throw error;
		}

		await callbacks?.onRetryAttemptStart?.();
	}
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new RetrySleepAbortError());
		};

		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	const parts = patterns.map((pattern) =>
		/^\d{3}$/.test(pattern) ? `\\b${pattern}\\b` : pattern,
	);

	return new RegExp(parts.join("|"), "i");
}
