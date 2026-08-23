import type { SpanOptions, TelemetryContext, TelemetrySpan } from "./index.ts";

const noopTelemetrySpan: TelemetrySpan = {
	startSpan: startNoopSpan,
	addEvent: () => {},
	setAttributes: () => {},
	setStatus: () => {},
};

async function startNoopSpan<T>(
	_options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	return callback(noopTelemetrySpan);
}

Object.freeze(noopTelemetrySpan);

export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = noopTelemetrySpan;
