import { describe, expect, it, vi } from "vitest";
import { TaskScheduler } from "../src/engine/scheduler.ts";
import { context } from "./session-support.ts";

describe("TaskScheduler open", () => {
	it("detaches subscriptions when open fails", async () => {
		const unsubscribe = vi.fn();
		const session = {
			subscribeCommits: vi.fn(() => unsubscribe),
			subscribeClose: vi.fn(() => unsubscribe),
			commitWith: vi.fn(async () => {
				throw new Error("disk full");
			}),
		};
		const registry = { subscribe: vi.fn(() => unsubscribe) };
		const scheduler = new TaskScheduler({
			session: session as never,
			storage: {} as never,
			registry: registry as never,
			models: {} as never,
			agent: async () => {
				throw new Error("unused");
			},
			settings: () => ({}) as never,
			env: async () => undefined,
			now: Date.now,
			report: () => {},
			settleOutcome: async () => {},
			withdrawInputs: async () => {},
			conversation: async () => undefined,
			context,
		});

		await expect(scheduler.open(context)).rejects.toThrow("disk full");
		expect(unsubscribe).toHaveBeenCalledTimes(3);
	});
});
