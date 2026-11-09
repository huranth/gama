import type { AgentTool } from "@huranth/gama-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@huranth/gama-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	frameSteeringContent,
	frameSteeringText,
	STEERING_NOTE,
	unwrapSteeringText,
} from "../src/core/steering.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./suite/harness.ts";

const WAIT_RELEASE_MS = 25;

function createWaitTool(): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait",
		parameters: Type.Object({}),
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, WAIT_RELEASE_MS));

			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
}

describe("steering framing", () => {
	it("wraps a mid-turn message with the tag and the note", () => {
		const framed = frameSteeringText("change the color");

		expect(framed.startsWith("<user_message_sent_while_working>")).toBe(true);
		expect(framed).toContain("change the color");
		expect(framed.endsWith(STEERING_NOTE)).toBe(true);
	});

	it("frames only once", () => {
		const once = frameSteeringText("go left");

		expect(frameSteeringText(once)).toBe(once);
	});

	it("unwraps back to the user's words", () => {
		const framed = frameSteeringText("use tabs, not spaces");

		expect(unwrapSteeringText(framed)).toBe("use tabs, not spaces");
	});

	it("leaves plain text alone", () => {
		expect(unwrapSteeringText("plain")).toBe("plain");
	});

	it("frames text and keeps images in place", () => {
		const framed = frameSteeringContent([
			{ type: "text", text: "look here" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);

		expect(framed[0]).toMatchObject({ type: "text" });
		expect((framed[0] as { text: string }).text).toContain("look here");
		expect(framed[1]).toEqual({ type: "image", data: "abc", mimeType: "image/png" });
	});
});

describe("steering delivery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("sends the frame to the model and keeps the raw text in the transcript", async () => {
		const harness = await createHarness({ tools: [createWaitTool()] });
		harnesses.push(harness);

		const seenByModel: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const lastUser = context.messages.findLast((message) => message.role === "user");
				seenByModel.push(getMessageText(lastUser));
				return fauxAssistantMessage("done");
			},
		]);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.steer("steer now");
		await promptPromise;

		expect(seenByModel[0]).toContain("<user_message_sent_while_working>");
		expect(seenByModel[0]).toContain("steer now");
		expect(seenByModel[0]).toContain(STEERING_NOTE);
		expect(getUserTexts(harness)).toContain("steer now");

		const steeringMessage = harness.session.messages.findLast(
			(message) => message.role === "user",
		);

		expect(steeringMessage?.role === "user" && steeringMessage.steering).toBe(true);
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});

	it("keeps follow-up text bare", async () => {
		const harness = await createHarness({ tools: [createWaitTool()] });
		harnesses.push(harness);

		const seenByModel: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const lastUser = context.messages.findLast((message) => message.role === "user");
				seenByModel.push(getMessageText(lastUser));
				return fauxAssistantMessage("done");
			},
			(context) => {
				const lastUser = context.messages.findLast((message) => message.role === "user");
				seenByModel.push(getMessageText(lastUser));
				return fauxAssistantMessage("finished");
			},
		]);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.followUp("after this");
		await promptPromise;

		const delivered = seenByModel.filter((text) => text.includes("after this"));
		expect(delivered.length).toBeGreaterThan(0);
		expect(delivered[0]).toBe("after this");
	});
});
