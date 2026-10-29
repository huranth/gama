import { describe, expect, it } from "vitest";
import {
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type SpanOptions,
	type SpanStatus,
	type TelemetrySpan,
} from "../src/index.ts";

function unreadable<T extends object>(value: T): T {
	return new Proxy(value, {
		get: () => {
			throw new Error("read");
		},
		getOwnPropertyDescriptor: () => {
			throw new Error("inspect");
		},
		ownKeys: () => {
			throw new Error("enumerate");
		},
	});
}

describe("NOOP_TELEMETRY_CONTEXT", () => {
	it("admits callbacks synchronously and reuses one inert span", async () => {
		let admitted = false;
		let firstSpan: TelemetrySpan | undefined;
		const result = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "first" }, async (span) => {
			admitted = true;
			firstSpan = span;
			const child = await span.startSpan({ name: "child" }, (childSpan) => childSpan);
			expect(child).toBe(span);
			return 42;
		});

		expect(admitted).toBe(true);
		expect(await result).toBe(42);
		expect(Object.isFrozen(firstSpan)).toBe(true);
	});

	it("preserves synchronous and asynchronous rejection values", async () => {
		const syncError = { kind: "sync" };
		const sync = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "sync" }, () => {
			throw syncError;
		});
		await expect(sync).rejects.toBe(syncError);

		const asyncError = { kind: "async" };
		const asyncResult = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "async" }, async () => {
			throw asyncError;
		});
		await expect(asyncResult).rejects.toBe(asyncError);
	});

	it("does not inspect or retain telemetry payloads", async () => {
		const options = unreadable<SpanOptions>({
			name: "operation",
			attributes: { secret: "prompt content" },
		});
		await NOOP_TELEMETRY_CONTEXT.startSpan(options, (span) => {
			const attributes = unreadable<SpanAttributes>({ secret: "content" });
			const status = unreadable<SpanStatus>({ status: "ok" });
			expect(() => span.addEvent("event", attributes)).not.toThrow();
			expect(() => span.setAttributes(attributes)).not.toThrow();
			expect(() => span.setStatus(status)).not.toThrow();
		});
	});
});
