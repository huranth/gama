import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";

// Opt-in only.
const live = process.env.GAMA_LIVE === "1";
const dir = mkdtempSync(join(tmpdir(), "gama-live-cache-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const filler = Array.from(
	{ length: 120 },
	(_, index) => `Rule ${index + 1}: keep replies short and name the file you touched.`,
).join("\n");

function hit(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt === 0 ? 0 : usage.cacheRead / prompt;
}

describe.skipIf(!live)("live prompt cache", () => {
	it("reuses the prefix on later turns", async () => {
		const { session } = await createAgentSession({ cwd: dir });
		const model = session.model;
		expect(model, "no model configured").toBeDefined();

		try {
			await session.prompt(`Follow these rules.\n${filler}\nReply with the word ready.`);
			await session.prompt("Name one rule you were given.");
			await session.prompt("Name another rule.");

			const usage = session.messages
				.filter((message) => message.role === "assistant")
				.map(
					(message) =>
						(message as { usage: { input: number; cacheRead: number; cacheWrite: number } })
							.usage,
				);

			for (const [index, turn] of usage.entries()) {
				console.log(
					`live request ${index + 1}: input=${turn.input} ` +
						`read=${turn.cacheRead} write=${turn.cacheWrite} ` +
						`hit=${(hit(turn) * 100).toFixed(1)}%`,
				);
			}

			const later = usage.slice(1);
			const best = Math.max(...later.map(hit));
			console.log(
				`live ${model?.provider}/${model?.id}: best later hit ${(best * 100).toFixed(1)}%`,
			);

			expect(later.length).toBeGreaterThan(0);
			expect(best).toBeGreaterThan(0.2);
		} finally {
			session.dispose();
		}
	}, 180_000);

	it("keeps the prefix through a real tool turn", async () => {
		writeFileSync(join(dir, "sample.txt"), "first line\nsecond line\n");
		const { session } = await createAgentSession({ cwd: dir });

		try {
			await session.prompt("Read sample.txt and reply with its first line only.");
			await session.prompt("What was the second line?");

			const usage = session.messages
				.filter((message) => message.role === "assistant")
				.map(
					(message) =>
						(message as { usage: { input: number; cacheRead: number; cacheWrite: number } })
							.usage,
				);

			for (const [index, turn] of usage.entries()) {
				console.log(
					`live tool request ${index + 1}: input=${turn.input} ` +
						`read=${turn.cacheRead} write=${turn.cacheWrite} ` +
						`hit=${(hit(turn) * 100).toFixed(1)}%`,
				);
			}

			const later = usage.slice(1);
			expect(later.length).toBeGreaterThan(0);
			expect(Math.max(...later.map(hit))).toBeGreaterThan(0.2);
		} finally {
			session.dispose();
		}
	}, 180_000);
});
