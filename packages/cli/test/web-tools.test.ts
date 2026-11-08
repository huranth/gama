import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@huranth/gama-agent-core";
import type { Component } from "@huranth/gama-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWebFetchTool,
	createWebFetchToolDefinition,
	webfetchToolSystemPromptContribution,
} from "../src/core/tools/webfetch.ts";
import { webfetchRenderers } from "../src/core/tools/ui/web.ts";
import { FETCH_KINDS, FetchError } from "../src/core/tools/web/read-url.ts";
import { createToolDefinitionFromAgentTool } from "../src/core/tools/tool-definition-wrapper.ts";
import type { ToolRenderContext } from "../src/core/ext/types.ts";
import { initTheme, theme } from "../src/term/theme/theme.ts";

const fetchMod = vi.hoisted(() => ({ fetchPage: vi.fn() }));

vi.mock("../src/core/tools/web/get.ts", () => ({ fetchPage: fetchMod.fetchPage }));

type Details = Record<string, unknown>;

function result(text: string, details: Details = {}): AgentToolResult<Details> {
	const content = [{ type: "text", text }] as AgentToolResult<Details>["content"];
	return { content, details };
}

function firstText(out: AgentToolResult<Details>): string {
	return (out.content[0] as { text: string }).text;
}

async function run(definition: any, args: unknown): Promise<AgentToolResult<Details>> {
	return definition.execute("call", args);
}

function context(args: Record<string, unknown> = {}, isError = false): ToolRenderContext {
	return {
		args,
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError,
	} satisfies ToolRenderContext;
}

function toText(fn: (...a: any[]) => any, ...call: any[]): string {
	const component = fn(...call) as Component;
	return stripVTControlCharacters(component.render(200).join("\n")).trim();
}

function renderCall(fn: any, args: unknown, contextArgs: Record<string, unknown> = {}): string {
	return toText(fn, args, theme, context(contextArgs));
}

function renderResult(fn: any, value: AgentToolResult<Details>): string {
	return toText(fn, value, { expanded: true, isPartial: false }, theme, context());
}

function renderCollapsed(fn: any, value: AgentToolResult<Details>): string {
	return toText(fn, value, { expanded: false, isPartial: false }, theme, context());
}

const page = (overrides: Details = {}) => ({
	url: "https://example.com/docs",
	finalUrl: "https://example.com/docs",
	title: "Docs",
	description: "A short guide",
	contentType: "text/html",
	text: "hello world",
	truncated: false,
	totalChars: 11,
	...overrides,
});

beforeAll(() => initTheme("dark"));

beforeEach(() => {
	fetchMod.fetchPage.mockReset();
});

describe("webfetch tool", () => {
	it("exposes metadata", () => {
		const definition = createWebFetchToolDefinition("/tmp");
		const tool = createWebFetchTool("/tmp");
		expect(definition.name).toBe("fetch");
		expect(definition.label).toBe("fetch");
		expect(definition.promptSnippet).toBe(webfetchToolSystemPromptContribution.snippet);
		expect(tool.name).toBe("fetch");
		expect(tool.label).toBe("fetch");
		expect(createToolDefinitionFromAgentTool(tool).name).toBe("fetch");
	});

	it("repairs args", () => {
		const definition = createWebFetchToolDefinition("/tmp");
		const repaired = definition.prepareArguments?.({
			url: "  https://example.com/docs  ",
			find: "  needle  ",
			max_chars: 99_999,
			offset: -4,
		});

		expect(repaired?.url).toBe("https://example.com/docs");
		expect(repaired?.find).toBe("needle");
		expect(repaired?.max_chars).toBe(99_999);
		expect(repaired?.offset).toBe(-1);
		expect(definition.prepareArguments?.(undefined)).toEqual({ url: "" });
	});

	it("rejects max_chars outside the documented range", async () => {
		const definition = createWebFetchToolDefinition("/tmp");

		await expect(
			run(definition, { url: "https://example.com/docs", max_chars: 50 }),
		).rejects.toThrow("Bad max_chars");
		await expect(
			run(definition, { url: "https://example.com/docs", max_chars: 99_999 }),
		).rejects.toThrow("Bad max_chars");
		expect(definition.prepareArguments?.({
			url: "x",
			max_chars: Number.POSITIVE_INFINITY
		})).not.toHaveProperty(
			"max_chars",
		);
		expect(definition.prepareArguments?.({ url: "x" })).not.toHaveProperty("max_chars");
	});

	it("rejects find mixed with paging params", async () => {
		const definition = createWebFetchToolDefinition("/tmp");

		await expect(
			run(definition, { url: "https://example.com/docs", find: "needle", max_chars: 1_000 }),
		).rejects.toThrow("Bad find");
		await expect(
			run(definition, { url: "https://example.com/docs", find: "needle", offset: 1 }),
		).rejects.toThrow("Bad find");
	});

	it("rejects an overlong find pattern", async () => {
		const definition = createWebFetchToolDefinition("/tmp");

		await expect(
			run(definition, { url: "https://example.com/docs", find: "x".repeat(201) }),
		).rejects.toThrow("Pattern too long");
	});

	it("formats a clean page with title, URL, description, and content", async () => {
		fetchMod.fetchPage.mockResolvedValue(page());
		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, { url: "https://example.com/docs" });

		expect(firstText(out)).toBe(
			"Docs\nhttps://example.com/docs\nA short guide\n\nhello world",
		);
		expect(out.details).toEqual({
			url: "https://example.com/docs",
			finalUrl: "https://example.com/docs",
			title: "Docs",
			truncated: false,
			totalChars: 11,
		});			expect(fetchMod.fetchPage).toHaveBeenCalledWith({
			url: "https://example.com/docs",
			maxChars: 20_000,
			fullText: true,
			signal: undefined,
		});
	});

	it("shows a soft-wall note in the content", async () => {
		fetchMod.fetchPage.mockResolvedValue(
			page({
				text: "NOWSECURE\nby nodriver",
				totalChars: 21,
				note: "Short page (21 chars); verify this is not a block or consent wall",
			}),
		);
		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, { url: "https://example.com/short-page" });

		expect(firstText(out)).toContain("[Short page (21 chars); verify this is not a block");
		expect(out.details.note).toContain("Short page");
	});

	it("returns numbered lines for find", async () => {
		fetchMod.fetchPage.mockResolvedValue(
			page({
				text: "one\nneedle here\nthree\nneedle again",
				totalChars: undefined,
			}),
		);
		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, {
			url: "https://example.com/find",
			find: "needle",
		});

		expect(firstText(out)).toContain('Matches for "needle": 2');
		expect(firstText(out)).toContain("2: needle here");
		expect(firstText(out)).toContain("4: needle again");
		expect(out.details.matches).toBe(2);
		expect(out.details.pattern).toBe("needle");
		expect(out.details.truncated).toBe(false);
	});

	it("rejects a negative or non-numeric offset", async () => {
		const definition = createWebFetchToolDefinition("/tmp");

		await expect(
			run(definition, { url: "https://example.com/offset", offset: -5 }),
		).rejects.toThrow("Bad offset");
		await expect(
			run(definition, { url: "https://example.com/offset", offset: Number.NaN }),
		).rejects.toThrow("Bad offset");
		expect(fetchMod.fetchPage).not.toHaveBeenCalled();
	});

	it("reports the total when find exceeds the 20-line display cap", async () => {
		const text = Array.from({ length: 25 }, (_, index) => `needle ${index + 1}`).join("\n");
		fetchMod.fetchPage.mockResolvedValue(page({ text, totalChars: undefined }));
		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, {
			url: "https://example.com/many-find",
			find: "needle",
		});

		expect(firstText(out)).toContain('Matches for "needle": 25');
		expect(firstText(out)).toContain("[Showing first 20 of 25 matches]");
		expect(out.details.matches).toBe(25);
		expect(out.details.shown).toBe(20);
	});

	it("snaps a resumed offset to a word boundary", async () => {
		const text = "alpha beta gamma delta";
		fetchMod.fetchPage.mockResolvedValue(
			page({ text, totalChars: text.length }),
		);
		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, {
			url: "https://example.com/snap",
			offset: 8,
			max_chars: 1_000,
		});

		expect(firstText(out)).toContain("\nbeta gamma delta");
		expect(firstText(out)).not.toContain("\neta gamma delta");
	});

	it("advances on an offset inside a long unbroken token", async () => {
		const body = "x".repeat(3_000);
		fetchMod.fetchPage.mockResolvedValue(page({ text: body, totalChars: 3_000 }));
		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, {
			url: "https://example.com/token",
			offset: 1_000,
			max_chars: 1_000,
		});

		expect(out.details.nextOffset).toBe(2_000);
	});

	it("keeps totalChars and nextOffset honest when capped", async () => {
		const body = "x".repeat(3_000);
		fetchMod.fetchPage.mockResolvedValue(
			page({ text: body, totalChars: 3_000 }),
		);
		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, {
			url: "https://example.com/long",
			max_chars: 1_000,
		});

		expect(out.details.totalChars).toBe(3_000);
		expect(out.details.nextOffset).toBe(1_000);
		expect(out.details.truncated).toBe(true);
		expect(firstText(out)).toContain("[Content truncated: next offset 1000]");
	});

	it("fails clearly when the URL is empty", async () => {
		const definition = createWebFetchToolDefinition("/tmp");
		await expect(run(definition, { url: "   " })).rejects.toThrow(
			"Bad URL",
		);
		expect(fetchMod.fetchPage).not.toHaveBeenCalled();
	});

	it("retries a transient 419 once", async () => {
		fetchMod.fetchPage
			.mockRejectedValueOnce(
				new FetchError(FETCH_KINDS.http, "Failed to fetch URL: HTTP 419 I'm a teapot"),
			)
			.mockResolvedValueOnce(page({ totalChars: undefined }));

		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, { url: "https://example.com/hn" });

		expect(firstText(out)).toContain("hello world");
		expect(fetchMod.fetchPage).toHaveBeenCalledTimes(2);
	});

	it("retries a timeout once", async () => {
		fetchMod.fetchPage
			.mockRejectedValueOnce(
				new FetchError(FETCH_KINDS.timeout, "Timed out after 30000 ms"),
			)
			.mockResolvedValueOnce(page({ totalChars: undefined }));

		const definition = createWebFetchToolDefinition("/tmp");
		const out = await run(definition, { url: "https://example.com/slow" });

		expect(firstText(out)).toContain("hello world");
		expect(fetchMod.fetchPage).toHaveBeenCalledTimes(2);
	});

	it("wraps the underlying fetch error", async () => {
		fetchMod.fetchPage.mockRejectedValue(new Error("denied by policy"));
		const definition = createWebFetchToolDefinition("/tmp");

		await expect(run(definition, { url: "https://example.com/secret" })).rejects.toThrow(
			"Fetch failed",
		);
	});

	it("never leaves a blank reason on connection failures", async () => {
		const failure = new Error("");
		Object.assign(failure, { code: "ECONNREFUSED" });
		fetchMod.fetchPage.mockRejectedValue(failure);
		const definition = createWebFetchToolDefinition("/tmp");

		await expect(run(definition, { url: "https://example.com/refused" })).rejects.toThrow(
			"Fetch failed",
		);
	});
});

describe("fetch renderers", () => {
	it("puts the URL in the call header even when args stream in late", () => {
		const line = renderCall(webfetchRenderers.renderCall, {}, {
			url: "https://www.postgresql.org/docs/current/indexes.html",
		});

		expect(line).toContain("fetch");
		expect(line).toContain("https://www.postgresql.org/docs/current/indexes.html");
	});

	it("renders a compact collapsed result", () => {
		const line = renderCollapsed(
			webfetchRenderers.renderResult,
			result("hello", { totalChars: 2_500, title: "Docs" }),
		);

		expect(line).toBe("Read 2,500 chars - Docs");
	});

	it("renders matches in the collapsed result", () => {
		const line = renderCollapsed(
			webfetchRenderers.renderResult,
			result("needle", { matches: 1, title: "Docs" }),
		);

		expect(line).toBe("1 match - Docs");
	});

	it("renders the full page when expanded", () => {
		const line = renderResult(
			webfetchRenderers.renderResult,
			result("Docs\nhttps://example.com/docs\n\nhello", {
				totalChars: 38,
				title: "Docs",
			}),
		);

		expect(line).toContain("Docs");
		expect(line).toContain("https://example.com/docs");
		expect(line).toContain("hello");
	});
});
