import type * as NodeZlib from "node:zlib";

import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses.js";

import { clampThinkingLevel } from "../models.ts";

import { registerSessionResourceCleanup } from "../session-resources.ts";

import type {
	AssistantMessage,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";

import { combineAbortSignals } from "../utils/abort-signals.ts";

import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";

import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";

import { AssistantMessageEventStream } from "../utils/event-stream.ts";

import { getGamaUserAgent } from "../utils/gama-user-agent.ts";

import { headersToRecord } from "../utils/headers.ts";

import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";

import { getSystemMessageText } from "../utils/text.ts";

import {
	getDeclaredTools,
	getInitialSystemMessage,
	normalizeContext,
	resolveTranscript,
	resolveTranscriptTools,
} from "../utils/transcript.ts";

import { uuidv7 } from "../utils/uuid.ts";

import { createGrammarToolInputProperties } from "./constrained-sampling.ts";

import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";

import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "./openai-responses-shared.ts";

import { buildBaseOptions } from "./simple-options.ts";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
	toolChoice?: "auto" | "none" | "required";
}

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

type CodexResponseStatus =
	| "completed"
	| "incomplete"
	| "failed"
	| "cancelled"
	| "queued"
	| "in_progress";

interface CodexRequestBody {
	model: string;
	store: boolean;
	stream: boolean;
	instructions: string;
	input: ResponseInput;
	text?: { verbosity?: "low" | "medium" | "high" };
	include?: string[];
	prompt_cache_key?: string;
	tool_choice?: "auto" | "none" | "required";
	parallel_tool_calls?: boolean;
	temperature?: number;
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	tools?: OpenAITool[];
	reasoning?: { effort?: string | null; summary?: string };
	previous_response_id?: string;
}

interface WebSocketLike {
	readyState?: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
}

type WebSocketConstructor = new (url: string, options?: unknown) => WebSocketLike;

interface CachedWebSocketContinuationState {
	lastRequestBody: CodexRequestBody;
	lastResponseId: string;
	lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;

const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";

const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

const TERMINAL_RATE_LIMIT = new RegExp(
	[
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"billing",
	].join("|"),
	"i",
);

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

const websocketSessionCache = new Map<string, Map<string, CachedWebSocketConnection>>();

const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();

const websocketSseFallbackSessions = new Set<string>();

const DEFAULT_MAX_RETRIES = 0;

const BASE_DELAY_MS = 1000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const RETRYABLE_ERROR_TEXT =
	/rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i;

let cachedWebsocket: WebSocketConstructor | null = null;

class RetryDelayExceededError extends Error {}

class NonRetryableError extends Error {}

class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(
		message: string,
		options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown },
	) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

class ProviderStreamEventCallbackError extends Error {
	constructor(cause: unknown) {
		super(formatThrownValue(cause));
		this.name = "ProviderStreamEventCallbackError";
		this.cause = cause;
	}
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function isTerminalRateLimitError(errorText: string): boolean {
	return TERMINAL_RATE_LIMIT.test(errorText);
}

export function getOpenAICodexWebSocketDebugStats(
	sessionId: string,
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = socket.readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function dropCachedWebSocket(
	sessionId: string,
	accountId: string,
	entry: CachedWebSocketConnection,
): void {
	const entries = websocketSessionCache.get(sessionId);
	if (entries?.get(accountId) === entry) entries.delete(accountId);
	if (entries?.size === 0) websocketSessionCache.delete(sessionId);
}

function requestBodyWithoutInput(
	body: CodexRequestBody,
): Omit<CodexRequestBody, "input" | "previous_response_id"> {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function requestBodiesMatchExceptInput(a: CodexRequestBody, b: CodexRequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function buildWebSocketHeaders(
	initHeaders: ProviderHeaders | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}

function extractCodexEventError(event: Record<string, unknown>): {
	code?: string;
	message?: string;
} {
	const nested =
		event.error && typeof event.error === "object"
			? (event.error as Record<string, unknown>)
			: undefined;
	return {
		code:
			typeof event.code === "string"
				? event.code
				: typeof nested?.code === "string"
					? nested.code
					: undefined,
		message:
			typeof event.message === "string"
				? event.message
				: typeof nested?.message === "string"
					? nested.message
					: undefined,
	};
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	return readyState === undefined || readyState === 1;
}

function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

function getServiceTierCostMultiplier(
	model: Model<"openai-codex-responses">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Model<"openai-codex-responses">,
): void {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total =
		usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus)
		? (status as CodexResponseStatus)
		: undefined;
}

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackSessions.clear();
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackSessions.add(sessionId);
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function isCodexNonTransportError(error: unknown): boolean {
	return (
		error instanceof CodexApiError ||
		error instanceof CodexProtocolError ||
		error instanceof ProviderStreamEventCallbackError
	);
}

async function* startWebSocketOutputOnFirstEvent<T>(
	events: AsyncIterable<T>,
	onStart: () => void,
): AsyncGenerator<T> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
		}
		yield event;
	}
}

function compressRequestBodyZstd(bodyJson: string): Uint8Array | null {
	const zlib = loadNodeZlib();
	if (!zlib || typeof zlib.zstdCompressSync !== "function") {
		return null;
	}
	try {
		const compressed = zlib.zstdCompressSync(bodyJson, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
		});
		return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
	} catch {
		return null;
	}
}

function resolveCodexWebSocketUrl(baseUrl: string | undefined): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1])) as Record<
			string,
			Record<string, unknown> | undefined
		>;
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId as string;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function validateRetryDelayMs(
	delayMs: number,
	options: { maxRetryDelayMs?: number } | undefined,
): number {
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
		throw new RetryDelayExceededError(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay ` +
				`(max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
		);
	}
	return delayMs;
}

function loadNodeZlib(): typeof NodeZlib | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (
		(
			process as unknown as { getBuiltinModule?: (name: string) => typeof NodeZlib }
		).getBuiltinModule?.("node:zlib") ?? null
	);
}

function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (
		responseServiceTier === "default" &&
		(requestServiceTier === "flex" || requestServiceTier === "priority")
	) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}

function resolveCodexUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function buildBaseCodexHeaders(
	initHeaders: ProviderHeaders | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(initHeaders as unknown as Record<string, string>);
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) {
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "gama");
	headers.set("User-Agent", getGamaUserAgent());
	return headers;
}

function buildSSEHeaders(
	initHeaders: ProviderHeaders | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId: string | undefined,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}

function buildCachedWebSocketRequestBody(
	entry: CachedWebSocketConnection,
	body: CodexRequestBody,
): CodexRequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}
	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}
	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

function scheduleSessionWebSocketExpiry(
	sessionId: string,
	accountId: string,
	entry: CachedWebSocketConnection,
): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;

		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		dropCachedWebSocket(sessionId, accountId, entry);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

function getCachedWebSocketInputDelta(
	body: CodexRequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}
	const currentInput = body.input ?? [];
	const baseline = [
		...(continuation.lastRequestBody.input ?? []),
		...continuation.lastResponseItems,
	];
	if (currentInput.length < baseline.length) {
		return undefined;
	}
	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}
	return currentInput.slice(baseline.length);
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? event.code : undefined;
		const reason = "reason" in event ? event.reason : undefined;
		const wasClean = "wasClean" in event ? event.wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			reasonText = " message too big";
		}
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 && isTerminalRateLimitError(errorText)) return false;
	if (RETRYABLE_STATUSES.has(status)) return true;

	return RETRYABLE_ERROR_TEXT.test(errorText);
}

function getRetryAfterDelayMs(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) {
			return Math.max(0, millis);
		}
	}
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) {
		return undefined;
	}
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}
	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}
	return undefined;
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data;
		return new TextDecoder().decode(
			new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
		);
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer(): Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: CachedWebSocketConnection): void => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	if (sessionId) {
		for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) {
			closeEntry(entry);
		}
		websocketSessionCache.delete(sessionId);
		return;
	}
	for (const accountEntries of websocketSessionCache.values()) {
		for (const entry of accountEntries.values()) {
			closeEntry(entry);
		}
	}
	websocketSessionCache.clear();
}

async function parseErrorResponse(
	response: Response,
): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;
	try {
		const parsed = JSON.parse(raw) as { error?: Record<string, unknown> } | undefined;
		const err = parsed?.error as
			| {
					code?: unknown;
					type?: unknown;
					plan_type?: string;
					resets_at?: number;
					message?: string;
			  }
			| undefined;
		if (err) {
			const code = (err.code as string) || (err.type as string) || "";
			const rateLimited = /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(
				code,
			);

			if (rateLimited || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const resetsAt = err.resets_at;
				let when = "";

				if (resetsAt) {
					const minutes = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000));

					when = ` Try again in ~${minutes} min.`;
				}

				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}

			message = (err.message as string) || friendlyMessage || message;
		}
	} catch {}
	return { message, friendlyMessage };
}

async function getWebSocketConstructor(
	env: ProviderEnv | undefined,
): Promise<WebSocketConstructor | null> {
	if (!env && cachedWebsocket) return cachedWebsocket;
	if (typeof process !== "undefined" && process.versions?.bun) {
		const WebSocketWithProxy = class extends WebSocket {
			constructor(url: string | URL, options?: unknown) {
				const hasProtocols = Array.isArray(options) || typeof options === "string";
				const wsOptions = hasProtocols
					? { protocols: options }
					: { ...(options as Record<string, unknown>) };

				const httpUrl = url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:");
				const proxyUrl = resolveHttpProxyUrlForTarget(httpUrl, env);
				const proxy = proxyUrl ? { proxy: proxyUrl.toString() } : {};

				super(url as string, { ...wsOptions, ...proxy } as never);
			}
		} as unknown as WebSocketConstructor;
		if (!env) {
			cachedWebsocket = WebSocketWithProxy;
		}
		return WebSocketWithProxy;
	}
	const ctor = globalThis.WebSocket as unknown as WebSocketConstructor | undefined;
	if (typeof ctor !== "function") return null;
	return ctor;
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? event.message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}
		const nestedError = "error" in event ? event.error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

async function connectWebSocket(
	url: string,
	headers: Headers,
	signal: AbortSignal | undefined,
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
	env?: ProviderEnv,
): Promise<WebSocketLike> {
	const WebSocketCtor = await getWebSocketConstructor(env);
	if (!WebSocketCtor) {
		throw new Error("WebSocket transport is not available in this runtime");
	}
	const wsHeaders = headersToRecord(headers) as Record<string, string | undefined>;
	delete wsHeaders["OpenAI-Beta"];
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;
		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, closeReason?: string): void => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) {
				closeWebSocketSilently(socket, 1000, closeReason);
			}
			reject(error);
		};
		const onOpen = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError = (event: unknown): void => {
			fail(extractWebSocketError(event));
		};
		const onClose = (event: unknown): void => {
			fail(extractWebSocketCloseError(event));
		};
		const onAbort = (): void => {
			fail(new Error("Request was aborted"), "aborted");
		};
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(
					new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`),
					"connect_timeout",
				);
			}, connectTimeoutMs);
		}
		if (signal?.aborted) {
			onAbort();
		}
	});
}

async function* mapCodexEvents(
	events: AsyncIterable<Record<string, unknown>>,
	output: AssistantMessage,
	model: Model<"openai-codex-responses">,
	onProviderStreamEvent: StreamOptions["onProviderStreamEvent"],
): AsyncGenerator<Record<string, unknown>> {
	for await (const event of events) {
		try {
			await onProviderStreamEvent?.(event as never, model);
		} catch (error) {
			throw new ProviderStreamEventCallbackError(error);
		}
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;
		if (type === "error") {
			const { code, message } = extractCodexEventError(event);
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event,
			});
		}
		if (type === "response.failed") {
			const response = event.response as
				| { error?: { code?: string; message?: string } }
				| undefined;
			const code = response?.error?.code;
			const message = response?.error?.message;
			throw new CodexApiError(message || "Codex response failed", { code, payload: event });
		}
		if (
			type === "response.done" ||
			type === "response.completed" ||
			type === "response.incomplete"
		) {
			const response = event.response as { end_turn?: unknown; status?: unknown } | undefined;
			if (typeof response?.end_turn === "boolean") {
				(output as AssistantMessage & { endTurn?: boolean }).endTurn = response.end_turn;
			}
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			yield {
				...event,
				type: "response.completed",
				response: normalizedResponse,
			};
			return;
		}
		yield event;
	}
}

interface WebSocketRelease {
	keep?: boolean;
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	accountId: string,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number | undefined,
	env: ProviderEnv | undefined,
): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: WebSocketRelease) => void;
}> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
		return {
			socket,
			reused: false,
			release: () => closeWebSocketSilently(socket),
		};
	}
	let accountEntries = websocketSessionCache.get(sessionId);
	const cached = accountEntries?.get(accountId);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		if (!cached.busy && isWebSocketSessionExpired(cached)) {
			closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
			dropCachedWebSocket(sessionId, accountId, cached);
		} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep }: WebSocketRelease = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						dropCachedWebSocket(sessionId, accountId, cached);

						return;
					}

					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, accountId, cached);
				},
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
			return {
				socket,
				reused: false,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			dropCachedWebSocket(sessionId, accountId, cached);
		}
	}
	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
	const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
	accountEntries = websocketSessionCache.get(sessionId);
	if (!accountEntries) {
		accountEntries = new Map();
		websocketSessionCache.set(sessionId, accountEntries);
	}
	accountEntries.set(accountId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep }: WebSocketRelease = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				dropCachedWebSocket(sessionId, accountId, entry);

				return;
			}

			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, accountId, entry);
		},
	};
}

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model,
	context,
	options,
) => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(
		context,
		model.compat?.supportsMidConvoSystemMessages,
	);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
			const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);

			let body = buildRequestBody(
				model,
				normalizedContext,
				options,
				codexSessionId,
				grammarToolInputProperties,
			);
			const nextBody = await options?.onPayload?.(body as never, model);
			if (nextBody !== undefined) {
				body = nextBody as CodexRequestBody;
			}

			const websocketRequestId = codexSessionId || uuidv7();
			const sseHeaders = buildSSEHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				codexSessionId,
			);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			const bodyJson = JSON.stringify(body);
			const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			const transport = options?.transport || "auto";
			let startEmitted = false;
			const websocketDisabledForSession =
				transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);

			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(cacheSessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				let retriedMissingWebSocketContinuation = false;
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							resolveCodexWebSocketUrl(model.baseUrl),
							body,
							websocketHeaders,
							output,
							stream,
							model,
							() => {
								websocketStarted = true;
								if (!startEmitted) {
									startEmitted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							httpTimeoutMs,
							websocketConnectTimeoutMs,
							cacheSessionId,
							accountId,
							grammarToolInputProperties,
							options,
						);
						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						assertSuccessfulOutput(output);
						stream.push({
							type: "done",
							reason: output.stopReason as "deferred" | "length" | "stop" | "toolUse",
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						const connectionLimitBeforeStart =
							!websocketStarted && isWebSocketConnectionLimitReachedError(error);
						const previousResponseNotFound = isPreviousResponseNotFoundError(error);
						if (
							!aborted &&
							previousResponseNotFound &&
							!retriedMissingWebSocketContinuation
						) {
							retriedMissingWebSocketContinuation = true;
							continue;
						}
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								...(websocketStarted ? {} : { fallbackTransport: "sse" }),
								eventsEmitted: websocketStarted,
								phase: websocketStarted
									? "after_message_stream_start"
									: "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						recordWebSocketFailure(cacheSessionId, error);
						if (websocketStarted) {
							throw error;
						}
						recordWebSocketSseFallback(cacheSessionId);
						break;
					}
				}
			}

			const compressedBody = compressRequestBodyZstd(bodyJson);
			if (compressedBody) {
				sseHeaders.set("content-encoding", "zstd");
			}
			const sseBody = compressedBody ?? bodyJson;
			let response: Response | undefined;
			let lastError: Error | undefined;
			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}
				try {
					const headerTimeoutSignal =
						httpTimeoutMs !== undefined && httpTimeoutMs > 0
							? AbortSignal.timeout(httpTimeoutMs)
							: undefined;
					const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
					try {
						response = await (options?.fetch ?? globalThis.fetch)(
							resolveCodexUrl(model.baseUrl),
							{
								method: "POST",
								headers: sseHeaders,
								body: sseBody,
								signal: combinedSignal.signal,
							},
						);
					} catch (error) {
						if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
							throw new Error(
								`Codex SSE response headers timed out after ${httpTimeoutMs}ms`,
							);
						}
						throw error;
					} finally {
						combinedSignal.cleanup();
					}

					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
						const delayMs =
							retryAfterDelayMs === undefined
								? BASE_DELAY_MS * 2 ** attempt
								: validateRetryDelayMs(retryAfterDelayMs, options);
						await sleep(delayMs, options?.signal);
						continue;
					}

					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new NonRetryableError(info.friendlyMessage || info.message);
				} catch (error) {
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}

					lastError = error instanceof Error ? error : new Error(String(error));
					if (
						attempt < maxRetries &&
						!(lastError instanceof RetryDelayExceededError) &&
						!(lastError instanceof NonRetryableError) &&
						!lastError.message.includes("usage limit")
					) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}
			if (!response.body) {
				throw new Error("No response body");
			}

			if (!startEmitted) {
				startEmitted = true;
				stream.push({ type: "start", partial: output });
			}

			await processStream(response, output, stream, model, grammarToolInputProperties, options);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			assertSuccessfulOutput(output);
			stream.push({
				type: "done",
				reason: output.stopReason as "deferred" | "length" | "stop" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { partialJson?: unknown }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({
				type: "error",
				reason: output.stopReason as "aborted" | "error",
				error: output,
			});
			stream.end();
		}
	})();

	return stream;
};

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<void> {
	await processResponsesStream(
		mapCodexEvents(
			parseSSE(response, options?.signal),
			output,
			model,
			options?.onProviderStreamEvent,
		) as unknown as Parameters<typeof processResponsesStream>[0],
		output,
		stream,
		model,
		{
			serviceTier: options?.serviceTier,
			grammarToolInputProperties,
			resolveServiceTier: resolveCodexServiceTier,
			applyServiceTierPricing: (usage, serviceTier) =>
				applyServiceTierPricing(usage, serviceTier, model),
		},
	);
}

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: (options as OpenAICodexResponsesOptions | undefined)?.toolChoice,
	};
	const clampedReasoning = options?.reasoning
		? clampThinkingLevel(model, options.reasoning)
		: undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	return stream(model, context, {
		...base,
		reasoningEffort,
	});
};

function assertSuccessfulOutput(output: AssistantMessage): void {
	if (output.stopReason === "pending") {
		throw new Error("Codex stream ended without a stop reason");
	}
	if (output.stopReason === "error" || output.stopReason === "aborted") {
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
}

async function* parseSSE(
	response: Response,
	signal: AbortSignal | undefined,
): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const onAbort = (): void => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { done, value } = await reader.read();
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (done && buffer.trim()) buffer += "\n\n";

			// Normalize CRLF.
			buffer = buffer.replace(/\r\n/g, "\n");

			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const chunk = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);

				const dataLines = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim());

				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as Record<string, unknown>;
						} catch (cause) {
							throw new CodexProtocolError(
								`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`,
								{
									cause,
									payload: data,
								},
							);
						}
					}
				}

				boundary = buffer.indexOf("\n\n");
			}

			if (done) break;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

async function processWebSocketStream(
	url: string,
	body: CodexRequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	idleTimeoutMs: number | undefined,
	websocketConnectTimeoutMs: number | undefined,
	cacheSessionId: string | undefined,
	accountId: string,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<void> {
	const { socket, entry, reused, release } = await acquireWebSocket(
		url,
		headers,
		cacheSessionId,
		accountId,
		options?.signal,
		websocketConnectTimeoutMs,
		options?.env,
	);
	let keepConnection = true;
	const useCachedContext =
		options?.transport === "websocket-cached" || options?.transport === "auto";
	const fullBody = body;
	const requestBody =
		useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;

	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}

	try {
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));

		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapCodexEvents(
					parseWebSocket(socket, options?.signal, idleTimeoutMs),
					output,
					model,
					options?.onProviderStreamEvent,
				) as unknown as Parameters<typeof processResponsesStream>[0],
				onStart,
			),
			output,
			stream,
			model,
			{
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) =>
					applyServiceTierPricing(usage, serviceTier, model),
			},
		);

		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (
			useCachedContext &&
			entry &&
			(output as AssistantMessage & { responseId?: string }).responseId
		) {
			const responseItems = convertResponsesMessages(
				model,
				normalizeContext({ messages: [output] }),
				CODEX_TOOL_CALL_PROVIDERS,
				{
					includeSystemPrompt: false,
					grammarToolInputProperties,
				},
			).filter(
				(item) =>
					item.type !== "function_call_output" && item.type !== "custom_tool_call_output",
			);
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: (output as AssistantMessage & { responseId?: string })
					.responseId as string,
				lastResponseItems: responseItems as ResponseInput,
			};
		}
	} catch (error) {
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options: OpenAICodexResponsesOptions | undefined,
	cacheSessionId: string | undefined,
	grammarToolInputProperties = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
): CodexRequestBody {
	const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		supportsAdditionalTools || supportsToolSearch,
	);

	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools,
		supportsToolSearch,
		toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
	});

	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";

	const body: CodexRequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: instructions || "You are a helpful assistant.",
		input: messages as ResponseInput,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: cacheSessionId,
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		body.tools = convertResponsesTools(transcriptTools.requestTools, {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		}) as OpenAITool[];
	}

	if (options?.reasoningEffort !== undefined) {
		const requested = options.reasoningEffort;
		const mappedOff = model.thinkingLevelMap?.off;
		let effort: string | null | undefined;

		if (requested === "none") {
			effort = mappedOff === undefined ? "none" : mappedOff;
		} else {
			effort = model.thinkingLevelMap?.[requested] ?? requested;
		}

		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	} else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
		body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}

	return body;
}

async function* parseWebSocket(
	socket: WebSocketLike,
	signal: AbortSignal | undefined,
	idleTimeoutMs: number | undefined,
): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = (): void => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	// Order intact.
	let decodeChain: Promise<void> = Promise.resolve();

	const onMessage = (event: unknown): void => {
		decodeChain = decodeChain.then(async () => {
			let text: string | null = null;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decodeWebSocketData((event as { data: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const type = typeof parsed.type === "string" ? parsed.type : "";
				if (
					type === "response.completed" ||
					type === "response.done" ||
					type === "response.incomplete"
				) {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new CodexProtocolError(
					`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`,
					{
						cause,
						payload: text,
					},
				);
				done = true;
				wake();
			}
		});
	};

	const onError = (event: unknown): void => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose = (event: unknown): void => {
		// Await decodes.
		void decodeChain.then(() => {
			if (sawCompletion) {
				done = true;
				wake();
				return;
			}
			if (!failed) {
				failed = extractWebSocketCloseError(event);
			}
			done = true;
			wake();
		});
	};

	const onAbort = (): void => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (queue.length > 0) {
				yield queue.shift() as Record<string, unknown>;
				continue;
			}
			if (done) break;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve, reject) => {
				pending = resolve;
				if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
					timeout = setTimeout(() => {
						const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
						failed = error;
						done = true;
						pending = null;
						closeWebSocketSilently(socket, 1000, "idle_timeout");
						reject(error);
					}, idleTimeoutMs);
				}
			}).finally(() => {
				if (timeout) {
					clearTimeout(timeout);
				}
			});
		}

		if (failed) {
			throw failed;
		}
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}
