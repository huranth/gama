import type {
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, test } from "vitest";
import { applyLayeredBreakpoint } from "../src/api/anthropic-messages.ts";

const cacheControl: CacheControlEphemeral = { type: "ephemeral" };

function makeParams(count: number): MessageParam[] {
	return Array.from({ length: count }, (_, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `m${i}` }],
	})) as MessageParam[];
}

describe("applyLayeredBreakpoint", () => {
	test("places a breakpoint on the block 12 positions back from the tail", () => {
		const params = makeParams(20);
		applyLayeredBreakpoint(params, cacheControl);
		const anchor = params[params.length - 1 - 12].content[0] as { cache_control?: unknown };
		expect(anchor.cache_control).toEqual(cacheControl);
		// Anchor only.
		const marks = params.filter((m) =>
			(m.content as { cache_control?: unknown }[]).some((b) => b.cache_control),
		);
		expect(marks).toHaveLength(1);
	});

	test("does nothing when the history is shorter than the lookback window", () => {
		const params = makeParams(13);
		applyLayeredBreakpoint(params, cacheControl);
		for (const m of params) {
			for (const b of m.content as { cache_control?: unknown }[]) {
				expect(b.cache_control).toBeUndefined();
			}
		}
	});

	test("does nothing without a cache control hint", () => {
		const params = makeParams(20);
		applyLayeredBreakpoint(params, undefined);
		for (const m of params) {
			for (const b of m.content as { cache_control?: unknown }[]) {
				expect(b.cache_control).toBeUndefined();
			}
		}
	});

	test("skips a marker on a non-cacheable block type", () => {
		const params = makeParams(20);
		(params[7].content as unknown[])[0] = { type: "thinking", thinking: "..." };
		applyLayeredBreakpoint(params, cacheControl);
		expect((params[7].content[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
	});

	test("keeps an existing cache_control marker untouched", () => {
		const params = makeParams(20);
		const existing: CacheControlEphemeral = { type: "ephemeral", ttl: "1h" };
		(params[7].content as { cache_control?: CacheControlEphemeral }[])[0].cache_control =
			existing;
		applyLayeredBreakpoint(params, cacheControl);
		expect((params[7].content[0] as { cache_control?: unknown }).cache_control).toEqual(existing);
	});

	test("anchors on a tool_result tail block", () => {
		const params = makeParams(20);
		(params[7].content as unknown[])[0] = {
			type: "tool_result",
			tool_use_id: "t1",
			content: "ok",
		};
		applyLayeredBreakpoint(params, cacheControl);
		expect((params[7].content[0] as { cache_control?: unknown }).cache_control).toEqual(
			cacheControl,
		);
	});
});
