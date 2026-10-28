import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";

const proto = InteractiveMode.prototype as unknown as {
	routeBuiltinInput(this: unknown, text: string): Promise<boolean>;
	handleAgentStart(this: unknown): void;
	handleAgentEnd(this: unknown, event: unknown): void;
	handleAgentSettled(this: unknown): Promise<void>;
};

afterEach(() => {
	vi.restoreAllMocks();
});

function compactContext(session: {
	isStreaming: boolean;
	isPreparingPrompt?: boolean;
	isCompacting: boolean;
	compact: unknown;
}) {
	return {
		session,
		editor: { setText: vi.fn() },
		showWarning: vi.fn(),
	};
}

describe("/compact", () => {
	test("runs session.compact with the instructions", async () => {
		const compact = vi.fn().mockResolvedValue({});
		const context = compactContext({ isStreaming: false, isCompacting: false, compact });
		expect(await proto.routeBuiltinInput.call(context, "/compact keep the schema")).toBe(true);
		expect(compact).toHaveBeenCalledWith("keep the schema");
		await proto.routeBuiltinInput.call(context, "/compact");
		expect(compact).toHaveBeenLastCalledWith(undefined);
	});

	test("is rejected while a response is streaming", async () => {
		const compact = vi.fn();
		const context = compactContext({ isStreaming: true, isCompacting: false, compact });
		expect(await proto.routeBuiltinInput.call(context, "/compact")).toBe(true);
		expect(compact).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith("Response in progress");
	});
});

describe("/compact while preparing", () => {
	test("is rejected while a prompt is being prepared", async () => {
		const compact = vi.fn();
		const context = compactContext({
			isStreaming: false,
			isPreparingPrompt: true,
			isCompacting: false,
			compact,
		});
		expect(await proto.routeBuiltinInput.call(context, "/compact")).toBe(true);
		expect(compact).not.toHaveBeenCalled();
		expect(context.showWarning).toHaveBeenCalledWith("Response in progress");
	});
});

describe("/bell", () => {
	function bellCommandContext(initial: boolean) {
		const settingsManager = {
			getNotifyOnTurnEnd: vi.fn(() => initial),
			setNotifyOnTurnEnd: vi.fn(),
		};
		return { settingsManager, editor: { setText: vi.fn() }, showStatus: vi.fn() };
	}

	test("toggles without an argument and honours on/off", async () => {
		const context = bellCommandContext(true);
		expect(await proto.routeBuiltinInput.call(context, "/bell")).toBe(true);
		expect(context.settingsManager.setNotifyOnTurnEnd).toHaveBeenLastCalledWith(false);
		await proto.routeBuiltinInput.call(context, "/bell on");
		expect(context.settingsManager.setNotifyOnTurnEnd).toHaveBeenLastCalledWith(true);
		expect(context.showStatus).toHaveBeenLastCalledWith("Turn bell on");
	});

	test("rejects an unknown argument", async () => {
		const context = bellCommandContext(true);
		await proto.routeBuiltinInput.call(context, "/bell maybe");
		expect(context.settingsManager.setNotifyOnTurnEnd).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Usage: /bell [on|off]");
	});
});

describe("turn-finished bell", () => {
	function bellContext(notifyOnTurnEnd = true) {
		return {
			pendingToolCalls: new Set(),
			defaultEditor: {},
			ui: { terminal: { write: vi.fn() }, requestRender: vi.fn() },
			settingsManager: {
				getNotifyOnTurnEnd: () => notifyOnTurnEnd,
				getShowTerminalProgress: () => false,
			},
			clearStatusIndicator: vi.fn(),
			settleRunningActivities: vi.fn(),
			settleCurrentActivity: vi.fn(),
			checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		};
	}

	const endEvent = (stopReason: string) => ({
		type: "agent_end",
		willRetry: false,
		messages: [{ role: "assistant", stopReason }],
	});

	async function runTurn(durationMs: number, notifyOnTurnEnd = true) {
		const context = bellContext(notifyOnTurnEnd);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		proto.handleAgentStart.call(context);
		now.mockReturnValue(1_000_000 + durationMs);
		await proto.handleAgentSettled.call(context);
		return context.ui.terminal.write;
	}

	test("rings BEL after a 20 s run", async () => {
		expect(await runTurn(20_000)).toHaveBeenCalledWith("\x07");
	});

	test("stays silent for a short run", async () => {
		expect(await runTurn(19_999)).not.toHaveBeenCalled();
	});

	test("stays silent when notifyOnTurnEnd is off", async () => {
		expect(await runTurn(60_000, false)).not.toHaveBeenCalled();
	});

	test("times a run split by agent.continue() from its first agent_start", async () => {
		const context = bellContext();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		proto.handleAgentStart.call(context);
		now.mockReturnValue(1_000_000 + 55_000);
		proto.handleAgentEnd.call(context, endEvent("error"));
		proto.handleAgentStart.call(context);
		now.mockReturnValue(1_000_000 + 65_000);
		proto.handleAgentEnd.call(context, endEvent("stop"));
		await proto.handleAgentSettled.call(context);
		expect(context.ui.terminal.write).toHaveBeenCalledWith("\x07");
	});

	test("stays silent when the user aborted the run", async () => {
		const context = bellContext();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		proto.handleAgentStart.call(context);
		now.mockReturnValue(1_000_000 + 60_000);
		proto.handleAgentEnd.call(context, endEvent("aborted"));
		await proto.handleAgentSettled.call(context);
		expect(context.ui.terminal.write).not.toHaveBeenCalled();
	});
});
