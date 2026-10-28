import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";

const proto = InteractiveMode.prototype as unknown as {
	routeBuiltinInput(this: unknown, text: string): Promise<boolean>;
	handleAgentStart(this: unknown): void;
	handleAgentSettled(this: unknown): Promise<void>;
};

afterEach(() => {
	vi.restoreAllMocks();
});

function compactContext(session: {
	isStreaming: boolean;
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

describe("turn-finished bell", () => {
	async function runTurn(durationMs: number, notifyOnTurnEnd = true) {
		const context = {
			pendingToolCalls: new Set(),
			defaultEditor: {},
			ui: { terminal: { write: vi.fn() } },
			settingsManager: { getNotifyOnTurnEnd: () => notifyOnTurnEnd },
			checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		};
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
});
