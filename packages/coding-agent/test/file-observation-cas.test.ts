import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import {
	createFileReadTracker,
	FILE_CHANGED_SINCE_READ_MESSAGE,
} from "../src/core/tools/file-read-tracker.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

let dir: string;

let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cas-"));
	file = join(dir, "target.txt");
	writeFileSync(file, "alpha-beta", "utf-8");
});

afterEach(() => {
	try {
		unlinkSync(file);
	} catch {
		// Never written.
	}
});

describe("file read tracker observed-version CAS", () => {
	it("passes for files never observed", () => {
		expect(() => createFileReadTracker().assertUnchanged(file)).not.toThrow();
	});

	it("passes when the file is untouched after the observation", () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		expect(() => tracker.assertUnchanged(file)).not.toThrow();
	});

	it("rejects when content changed on disk since the observation", () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		writeFileSync(file, "changed", "utf-8");
		expect(() => tracker.assertUnchanged(file)).toThrow(FILE_CHANGED_SINCE_READ_MESSAGE);
	});

	it("rejects when the file disappeared after the observation", () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		unlinkSync(file);
		expect(() => tracker.assertUnchanged(file)).toThrow(/it was deleted since you read it/);
	});

	it("markWritten refreshes the observed version", () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		writeFileSync(file, "changed by session", "utf-8");
		tracker.markWritten(file);
		expect(() => tracker.assertUnchanged(file)).not.toThrow();
	});

	it("re-reading after an outside change refreshes the observed version", () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		writeFileSync(file, "outside change", "utf-8");
		expect(() => tracker.assertUnchanged(file)).toThrow();
		tracker.markRead(file);
		expect(() => tracker.assertUnchanged(file)).not.toThrow();
	});
});

describe("edit tool observed-version CAS", () => {
	it("applies the edit when the file is unchanged since read", async () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		const tool = createEditToolDefinition(dir, { tracker });
		const result = await tool.execute(
			"call-1",
			{ path: "target.txt", edits: [{ oldText: "alpha", newText: "gamma" }] },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);
		expect(result.content).toEqual([{ type: "text", text: "Edited 1 block in target.txt" }]);
	});

	it("refuses the edit when the file changed on disk since read", async () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		writeFileSync(file, "outside beta change", "utf-8");
		const tool = createEditToolDefinition(dir, { tracker });
		await expect(
			tool.execute(
				"call-2",
				{ path: "target.txt", edits: [{ oldText: "alpha", newText: "gamma" }] },
				undefined,
				undefined,
				{} as Parameters<typeof tool.execute>[4],
			),
		).rejects.toThrow(FILE_CHANGED_SINCE_READ_MESSAGE);
	});

	it("edits untracked files without a version gate", async () => {
		const tool = createEditToolDefinition(dir, {});
		const result = await tool.execute(
			"call-3",
			{ path: "target.txt", edits: [{ oldText: "alpha", newText: "gamma" }] },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);
		expect(result.content).toHaveLength(1);
	});
});

describe("write tool observed-version CAS", () => {
	it("allows the first full overwrite once the file was read", async () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		const tool = createWriteToolDefinition(dir, { tracker });
		const result = await tool.execute(
			"w-1",
			{ path: "target.txt", content: "full rewrite" },
			undefined,
			undefined,
			{} as Parameters<typeof tool.execute>[4],
		);
		expect(result.details).toBeDefined();
	});

	it("refuses a full overwrite when the file changed outside the session", async () => {
		const tracker = createFileReadTracker();
		tracker.markRead(file);
		writeFileSync(file, "outside change", "utf-8");
		const tool = createWriteToolDefinition(dir, { tracker });
		await expect(
			tool.execute(
				"w-2",
				{ path: "target.txt", content: "full rewrite" },
				undefined,
				undefined,
				{} as Parameters<typeof tool.execute>[4],
			),
		).rejects.toThrow(FILE_CHANGED_SINCE_READ_MESSAGE);
	});
});
