import { EventEmitter } from "node:events";
import * as undici from "undici";

const MS_PER_SECOND = 1_000;

const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

// Default idle
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300 * MS_PER_SECOND;

const IDLE_TIMEOUT_SECONDS = [30, 60, 120, 300];

function idleTimeoutLabel(seconds: number): string {
	if (seconds < 60) return `${seconds} sec`;

	return `${seconds / 60} min`;
}

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	...IDLE_TIMEOUT_SECONDS.map((seconds) => ({
		label: idleTimeoutLabel(seconds),
		timeoutMs: seconds * MS_PER_SECOND,
	})),
	{ label: "disabled", timeoutMs: 0 },
];

const originalGlobalFetch = globalThis.fetch;

let installedGlobalFetch: typeof globalThis.fetch | undefined;

// Swallow errors
const ignoreUndiciDispatcherError = (): void => {};

function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}

	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}

	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") return 0;
		if (trimmed.length === 0) return undefined;

		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}

	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) return choice.label;

	return `${timeoutMs / MS_PER_SECOND} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;

	if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = proxy;
	if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = proxy;
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid timeout: ${String(timeoutMs)}`);
	}

	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			proxyTunnel: true,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);

	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;

	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
