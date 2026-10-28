import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";

const proto = InteractiveMode.prototype as unknown as {
	routeBuiltinInput(this: unknown, text: string): Promise<boolean>;
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
