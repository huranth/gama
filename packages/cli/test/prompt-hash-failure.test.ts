import {
	type AssistantMessage,
	type ReplyStream,
	createReplyStream,
	fauxAssistantMessage,
	fauxText,
} from "@huranth/gama-ai";
import { describe, expect, it } from "vitest";
import { fingerprintPrompt, withPromptCacheStamping } from "../src/core/cache/prompt-hash.ts";
import { testAnthropicModel as model } from "./model-run-test-utils.ts";

function brokenSource(
	error: Error,
	partial?: AssistantMessage,
): ReplyStream {
	return {
		async *[Symbol.asyncIterator]() {
			if (partial) yield { type: "start", partial } as const;
			throw error;
		},
		result: () => Promise.reject(error),
	} as unknown as ReplyStream;
}

describe("prompt cache stamping failures", () => {
	it("turns a broken source into a stamped error event", async () => {
		const fingerprint = fingerprintPrompt({ messages: [{ role: "user" }] });
		const partial = fauxAssistantMessage([fauxText("half")]);
		const stamped = withPromptCacheStamping(
			brokenSource(new Error("provider exploded"), partial),
			fingerprint,
			model,
		);

		const events = [];
		for await (const event of stamped) events.push(event);

		const last = events.at(-1);
		if (last?.type !== "error") throw new Error("missing error event");

		expect(last.reason).toBe("error");
		expect(last.error.errorMessage).toBe("provider exploded");
		expect(last.error.promptHash).toBe(fingerprint.full);
		expect(last.error.promptMessages).toBe(1);

		expect((await stamped.result()).errorMessage).toBe("provider exploded");
	});

	it("leaves no unhandled rejection behind", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);

		try {
			const stamped = withPromptCacheStamping(
				brokenSource(new Error("provider exploded")),
				fingerprintPrompt({ messages: [] }),
				model,
			);

			for await (const _event of stamped) {
				// Drain
			}

			await new Promise((resolve) => setImmediate(resolve));
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("ends with an error when the source has no result", async () => {
		const fingerprint = fingerprintPrompt({ messages: [] });
		const source = createReplyStream();
		const stamped = withPromptCacheStamping(source, fingerprint, model);

		source.end();

		const events = [];
		for await (const event of stamped) events.push(event);

		const last = events.at(-1);
		if (last?.type !== "error") throw new Error("missing error event");

		expect(last.error.errorMessage).toBe("No stream result");
		expect(last.error.model).toBe(model.id);
		expect(last.error.promptHash).toBe(fingerprint.full);
	});
});
