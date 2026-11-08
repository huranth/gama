import { beforeAll, describe, expect, test, vi } from "vitest";
import type { CacheSnapshot } from "../src/core/cache/index.ts";
import { TermApp } from "../src/term/app.ts";
import { FooterComponent } from "../src/term/parts/footer.ts";
import { initTheme } from "../src/term/theme/theme.ts";

function snapshot(): CacheSnapshot {
	return {
		rates: [0.4, 0.98],
		latest: 0.98,
		totals: {
			input: 1000,
			cacheRead: 9000,
			cacheWrite: 2000,
			output: 500,
			prompt: 12000,
			hit: 0.75,
			spent: 0.02,
			uncached: 0.09,
			saved: 0.07,
		},
		windowMs: 300_000,
		leftMs: 120_000,
		nextWarm: 0.001,
		nextCold: 0.01,
		model: "openai/gpt",
		warmTurns: 0,
		coldTurns: 0,
		warmRatio: 0,
		unreported: 0,
		lookbackPositions: undefined,
		warmSpent: 0,
		warmRequests: 0,
	};
}

function footerSession(data: CacheSnapshot) {
	return {
		state: {
			model: { id: "gpt", provider: "openai", reasoning: false, contextWindow: 1000 },
			thinkingLevel: "off",
		},
		routedModel: undefined,
		model: { id: "gpt", provider: "openai", contextWindow: 1000 },
		sessionManager: {
			getEntryCount: () => 0,
			getSessionId: () => "session",
			getLeafId: () => null,
			getEntries: () => [],
			getCwd: () => "/tmp",
			getSessionName: () => undefined,
		},
		getContextUsage: () => undefined,
		cacheSnapshot: () => data,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("TermApp /cache", () => {
	beforeAll(() => initTheme("dark"));

	test("submitting /cache opens the panel without prompting", async () => {
		const fakeThis: any = {
			defaultEditor: {},
			dismissWelcomeLogo: vi.fn(),
			editor: { setText: vi.fn(), addToHistory: vi.fn() },
			showCachePanel: vi.fn(),
			routeBuiltinInput: (TermApp as any).prototype.routeBuiltinInput,
			session: { isBashRunning: false, isCompacting: false, prompt: vi.fn() },
		};

		(TermApp as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		await fakeThis.defaultEditor.onSubmit("/cache");

		expect(fakeThis.showCachePanel).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("panel rows cover hit rate, reads, writes, and savings", () => {
		const rows: Array<[string, string]> = [];
		const fakeThis: any = {
			session: { cacheSnapshot: () => snapshot() },
			showContextPanel: (panelRows: Array<[string, string]>) => rows.push(...panelRows),
		};

		(TermApp as any).prototype.showCachePanel.call(fakeThis);

		const labels = rows.map(([label]) => label);
		expect(labels).toEqual(expect.arrayContaining(["hit rate", "read", "write", "saved"]));
		expect(rows).toContainEqual(["hit rate", "98.0%"]);
		expect(rows).toContainEqual(["saved", "$0.070"]);
	});

	test("footer leads with the labeled hit rate and the cost", () => {
		const footerData: any = {
			getAvailableProviderCount: () => 1,
			getExtensionStatuses: () => new Map(),
		};
		const footer = new FooterComponent(footerSession(snapshot()) as any, footerData);

		const line = stripAnsi(footer.render(120)[0] ?? "");

		expect(line.startsWith("cache")).toBe(true);
		expect(line).toContain("98.0%");
		expect(line).toContain("$0.00");
		expect(line).toContain("gpt");
		expect(line).not.toContain("saved");
	});
});

describe("TermApp /stats", () => {
	beforeAll(() => initTheme("dark"));

	test("submitting /stats opens the panel without prompting", async () => {
		const fakeThis: any = {
			defaultEditor: {},
			dismissWelcomeLogo: vi.fn(),
			editor: { setText: vi.fn(), addToHistory: vi.fn() },
			showStatsPanel: vi.fn(),
			routeBuiltinInput: (TermApp as any).prototype.routeBuiltinInput,
			session: { isBashRunning: false, isCompacting: false, prompt: vi.fn() },
		};

		(TermApp as any).prototype.setupEditorSubmitHandler.call(fakeThis);
		await fakeThis.defaultEditor.onSubmit("/stats");

		expect(fakeThis.showStatsPanel).toHaveBeenCalledTimes(1);
		expect(fakeThis.editor.setText).toHaveBeenCalledWith("");
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("panel rows cover context, session counts, and tokens", () => {
		const rows: Array<[string, string]> = [];
		const fakeThis: any = {
			session: {
				model: { provider: "openai", id: "gpt" },
				getSessionStats: () => ({
					sessionFile: undefined,
					sessionId: "session",
					userMessages: 1,
					assistantMessages: 1,
					toolCalls: 2,
					toolResults: 2,
					totalMessages: 4,
					tokens: { input: 1200, output: 300, cacheRead: 500, cacheWrite: 100, total: 2100 },
					cost: 0.0042,
					cache: snapshot(),
					contextUsage: { tokens: 1500, contextWindow: 10000, percent: 15 },
				}),
			},
			showContextPanel: (panelRows: Array<[string, string]>) => rows.push(...panelRows),
		};

		(TermApp as any).prototype.showStatsPanel.call(fakeThis);

		expect(rows.map(([label]) => label)).toEqual(["context", "session", "tokens"]);
		expect(rows).toContainEqual(["context", "1.5k / 10k"]);
		const session = rows.find(([label]) => label === "session")?.[1] ?? "";
		expect(session).toContain("4 msgs");
		expect(session).toContain("2 tools");
		expect(session).not.toContain("B");
		expect(rows.find(([label]) => label === "tokens")?.[1]).toBe("in 1.2k, out 300");
	});
});
