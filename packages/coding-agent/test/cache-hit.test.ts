import type { Usage } from "@huranth/gama-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@huranth/gama-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

function usageOf(harness: Harness): Usage[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => (message as { usage: Usage }).usage);
}

function hitRate(usage: Usage): number {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt === 0 ? 0 : usage.cacheRead / prompt;
}

// Session gating.
async function session(): Promise<Harness> {
	const harness = await createHarness({ settings: { compaction: { enabled: false } } });
	harnesses.push(harness);
	(harness.session as unknown as { agent: { sessionId?: string } }).agent.sessionId =
		harness.sessionManager.getSessionId();
	return harness;
}

describe("prompt cache reuse", () => {
	it("reuses the whole prefix after the first turn", async () => {
		const harness = await session();
		for (let turn = 0; turn < 6; turn++) {
			harness.setResponses([fauxAssistantMessage([fauxText(`answer ${turn}`)])]);
			await harness.session.prompt(`question number ${turn}`);
		}

		const usage = usageOf(harness);
		expect(usage).toHaveLength(6);
		expect(hitRate(usage[0])).toBe(0);

		for (const turn of usage.slice(1)) {
			expect(hitRate(turn)).toBeGreaterThan(0.97);
			expect(turn.cacheWrite).toBeLessThan(turn.cacheRead / 50);
		}
	});

	it("keeps the prefix stable across tool turns and system prompt updates", async () => {
		const harness = await session();
		for (let turn = 0; turn < 4; turn++) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${turn}` })]),
				fauxAssistantMessage([fauxText(`done ${turn}`)]),
			]);
			await harness.session.prompt(`run step ${turn}`);
			harness.session.setActiveToolsByName(harness.session.getActiveToolNames());
		}

		const usage = usageOf(harness);
		for (const turn of usage.slice(1)) {
			expect(hitRate(turn)).toBeGreaterThan(0.95);
		}
	});
});
