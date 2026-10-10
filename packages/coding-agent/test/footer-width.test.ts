import { visibleWidth } from "@huranth/gama-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { CacheSnapshot } from "../src/core/cache/index.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/tui/parts/footer.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	routedModel?: { model: { id: string }; thinkingLevel?: string };
	contextPercent?: number | null;
	cacheRates?: number[];
	cacheSaved?: number;
	cacheWindowMs?: number;
	cacheLeftMs?: number;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			contextWindow: 200_000,
			percent: options.contextPercent === undefined ? 12.3 : options.contextPercent,
		}),
		cacheSnapshot: () => createSnapshot(options),
		routedModel: options.routedModel,
		modelRuntime: {},
	};

	return session as unknown as AgentSession;
}

function createSnapshot(options: {
	cacheRates?: number[];
	cacheSaved?: number;
	cacheWindowMs?: number;
	cacheLeftMs?: number;
}): CacheSnapshot {
	const rates = options.cacheRates ?? [];
	const saved = options.cacheSaved ?? 0;
	const latest = rates[rates.length - 1] ?? 0;

	return {
		rates,
		latest,
		totals: {
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			prompt: 0,
			hit: latest,
			spent: 0,
			uncached: saved,
			saved,
		},
		windowMs: options.cacheWindowMs,
		leftMs: options.cacheLeftMs ?? 0,
		nextWarm: undefined,
		nextCold: undefined,
		model: undefined,
		warmTurns: 0,
		coldTurns: 0,
		warmRatio: 0,
		unreported: 0,
		lookbackPositions: undefined,
		warmSpent: 0,
		warmRequests: 0,
	};
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("collapses the workspace directory to its basename", () => {
		expect(formatCwdForFooter("/home/user2")).toBe("user2");
		expect(formatCwdForFooter("/home/user")).toBe("user");
		expect(formatCwdForFooter("/home/user/project")).toBe("project");
	});

	it("handles windows separators, trailing slashes, and roots", () => {
		expect(formatCwdForFooter("C:\\Users\\example\\Downloads\\demo-main")).toBe("demo-main");
		expect(formatCwdForFooter("/home/user/project/")).toBe("project");
		expect(formatCwdForFooter("/")).toBe("/");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows the physical model a virtual model routed to", () => {
		const session = createSession({
			sessionName: "",
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[0]);

		expect(statsLine).toContain("auto");
		expect(statsLine).toContain("pushing");
		expect(statsLine).toContain("on gpt-5.6-luna");
		expect(statsLine).toContain("steady");
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[0]);
		expect(statsLine).toContain("$1.250");
	});

	it("updates cached usage totals after an entry is appended", () => {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		const session = createSession({ sessionName: "", usage });
		const footer = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(footer.render(120)[0])).toContain("$0.500");

		session.sessionManager
			.getEntries()
			.push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.render(120)[0])).toContain("$1.000");
	});

	it("shows the session cost on the stats line", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 50,
				cacheWrite: 70,
				cost: { total: 0.041 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[0]);
		expect(statsLine).toContain("$0.041");
	});

	it("renders one calm line with the model and no cwd, branch, or session name", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(120);
		expect(lines).toHaveLength(1);
		const line = stripAnsi(lines[0]);
		expect(line).not.toContain("─");
		expect(line).not.toContain("project");
		expect(line).not.toContain("main");
		expect(line).toContain("test-model");
	});

	it("keeps the model visible on narrow terminals", () => {
		const session = createSession({
			sessionName: "named",
			usage: { input: 6000, output: 10, cacheRead: 2000, cacheWrite: 0, cost: { total: 0.02 } },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(60);
		expect(lines).toHaveLength(1);
		const line = stripAnsi(lines[0]);
		expect(line).toContain("test-model");
		expect(line).toContain("cache");
		expect(line).toContain("n/a");
		expect(line).not.toContain("named");
	});

	it("shows the labeled hit rate on narrow terminals", () => {
		const session = createSession({ sessionName: "", cacheRates: [0.5, 0.973] });
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(60)[0]);

		expect(line).toContain("cache");
		expect(line).toContain("97.3%");
		expect(line).toContain("test-model");
	});

	it("shows the context chip only once compaction pressure is high", () => {
		const calm = createSession({ sessionName: "", contextPercent: 42 });
		const calmLine = stripAnsi(new FooterComponent(calm, createFooterData(1)).render(120)[0]);
		expect(calmLine).not.toContain("ctx");

		const warm = createSession({ sessionName: "", contextPercent: 82 });
		const footer = new FooterComponent(warm, createFooterData(1));
		expect(stripAnsi(footer.render(120)[0])).toContain("ctx 82% auto");

		footer.setAutoCompactEnabled(false);
		const manual = stripAnsi(footer.render(120)[0]);
		expect(manual).toContain("ctx 82%");
		expect(manual).not.toContain("auto");
	});

	it("shows the selected reasoning level for a model without reasoning support", () => {
		const session = createSession({
			sessionName: "",
			reasoning: false,
			thinkingLevel: "off",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toContain("parked");
	});

	it("shows the model without a provider prefix", () => {
		const session = createSession({ sessionName: "named", provider: "tokenharbor" });
		const footer = new FooterComponent(session, createFooterData(1));

		const line = stripAnsi(footer.render(120)[0]);
		expect(line).toContain("test-model");
		expect(line).not.toContain("tokenharbor");
		expect(line).not.toContain("named");
	});

	it("appends extension statuses as a second line", () => {
		const session = createSession({ sessionName: "" });
		const footerData = createFooterData(1);
		footerData.getExtensionStatuses = () => new Map([["ext", "ready"]]);
		const footer = new FooterComponent(session, footerData);

		const lines = footer.render(120);
		expect(lines).toHaveLength(2);
		expect(stripAnsi(lines[1])).toBe("ready");
	});
});
describe("FooterComponent streaming cost", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("shows zero cost from the start with no usage yet", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[0])).toContain("$0.00");
	});

	it("tracks cost while a stream is in flight", () => {
		const session = createSession({
			sessionName: "",
			usage: { input: 260, output: 45, cacheRead: 2000, cacheWrite: 0, cost: { total: 0.2 } },
		});
		const footer = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(footer.render(120)[0])).toContain("$0.200");

		footer.setStreamingUsage(undefined, 1000);
		expect(stripAnsi(footer.render(120)[0])).toContain("$0.400");

		// Real usage.
		footer.setStreamingUsage({
			input: 300,
			output: 60,
			cacheRead: 2100,
			cacheWrite: 0,
			totalTokens: 2460,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.21 },
		});
		expect(stripAnsi(footer.render(120)[0])).toContain("$0.410");

		footer.clearStreamingUsage();
		expect(stripAnsi(footer.render(120)[0])).toContain("$0.200");
	});

	it("drops the in-flight estimate once the completed entry is appended", () => {
		const usage = {
			input: 260,
			output: 45,
			cacheRead: 2000,
			cacheWrite: 0,
			cost: { total: 0.2 },
		};
		const session = createSession({ sessionName: "", usage });
		const footer = new FooterComponent(session, createFooterData(1));

		footer.setStreamingUsage(undefined, 1000);
		expect(stripAnsi(footer.render(120)[0])).toContain("$0.400");

		const settled = {
			input: 999,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { total: 0.1 },
		};
		session.sessionManager
			.getEntries()
			.push({ type: "message", message: { role: "assistant", usage: settled } } as never);

		expect(stripAnsi(footer.render(120)[0])).toContain("$0.300");
	});
});
