import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@huranth/gama-ai";
import type { ToolResultMessage } from "@huranth/gama-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/ext/types.ts";
import {
	createFileReadTracker,
	READ_BEFORE_CHANGE_MESSAGE,
} from "../src/core/tools/file-read-tracker.ts";
import { createAllToolDefinitions, createAllTools } from "../src/core/tools/index.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./suite/harness.ts";

let dir: string;
let ctx: ExtensionToolContext;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "gama-read-before-write-"));
	ctx = { cwd: dir } as ExtensionToolContext;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("read before write", () => {
	it("rejects overwriting an existing file that was never read", async () => {
		await writeFile(join(dir, "a.txt"), "old");
		const tracker = createFileReadTracker();
		const write = createWriteToolDefinition(dir, { tracker });

		await expect(
			write.execute("call", { path: "a.txt", content: "new" }, undefined, undefined, ctx),
		).rejects.toThrow(READ_BEFORE_CHANGE_MESSAGE);
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("old");
	});

	it("allows the overwrite once the file has been read", async () => {
		await writeFile(join(dir, "a.txt"), "old");
		const tracker = createFileReadTracker();
		tracker.markRead(join(dir, "a.txt"));
		const write = createWriteToolDefinition(dir, { tracker });

		const result = await write.execute(
			"call",
			{ path: "a.txt", content: "new" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toEqual({ created: false });
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("new");
	});

	it("allows creating files that do not exist yet", async () => {
		const tracker = createFileReadTracker();
		const write = createWriteToolDefinition(dir, { tracker });

		const result = await write.execute(
			"call",
			{
				path: "nested/new.txt",
				content: "hello",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toEqual({ created: true });
		expect(await readFile(join(dir, "nested/new.txt"), "utf8")).toBe("hello");
	});

	it("remembers files it wrote, so a second write needs no read", async () => {
		const tracker = createFileReadTracker();
		const write = createWriteToolDefinition(dir, { tracker });

		await write.execute("one", { path: "new.txt", content: "one" }, undefined, undefined, ctx);
		const second = await write.execute(
			"two",
			{ path: "new.txt", content: "two" },
			undefined,
			undefined,
			ctx,
		);
		expect(second.details).toEqual({ created: false });
		expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("two");
	});

	it("unlocks a file through the read tool", async () => {
		await writeFile(join(dir, "b.txt"), "old");
		const tracker = createFileReadTracker();
		const read = createReadToolDefinition(dir, { tracker });
		const write = createWriteToolDefinition(dir, { tracker });

		await read.execute("read", { path: "b.txt" }, undefined, undefined, ctx);
		const result = await write.execute(
			"write",
			{ path: "b.txt", content: "new" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toEqual({ created: false });
		expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("new");
	});

	it("does not unlock other files that were not read", async () => {
		await writeFile(join(dir, "a.txt"), "a");
		await writeFile(join(dir, "b.txt"), "b");
		const tracker = createFileReadTracker();
		const read = createReadToolDefinition(dir, { tracker });
		const write = createWriteToolDefinition(dir, { tracker });

		await read.execute("read", { path: "a.txt" }, undefined, undefined, ctx);
		await expect(
			write.execute("write", { path: "b.txt", content: "changed" }, undefined, undefined, ctx),
		).rejects.toThrow(READ_BEFORE_CHANGE_MESSAGE);
		expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("b");
	});

	it("matches the same file through different relative paths", async () => {
		await writeFile(join(dir, "a.txt"), "old");
		const tracker = createFileReadTracker();
		const read = createReadToolDefinition(dir, { tracker });
		const write = createWriteToolDefinition(dir, { tracker });

		await read.execute("read", { path: "./sub/../a.txt" }, undefined, undefined, ctx);
		const result = await write.execute(
			"write",
			{ path: "a.txt", content: "new" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toEqual({ created: false });
		expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("new");
	});

	it("shares one tracker between read and write in the tool bundle", async () => {
		await writeFile(join(dir, "c.txt"), "old");
		const tracker = createFileReadTracker();
		const tools = createAllTools(dir, { files: tracker });

		await expect(
			tools.write.execute("write", { path: "c.txt", content: "new" }, undefined, undefined),
		).rejects.toThrow(READ_BEFORE_CHANGE_MESSAGE);
		await tools.read.execute("read", { path: "c.txt" }, undefined, undefined);
		await expect(
			tools.write.execute("write", { path: "c.txt", content: "new" }, undefined, undefined),
		).resolves.toBeDefined();
		expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("new");
	});
});

describe("edit shares the tracker in the full tool bundle", () => {
	it("createAllToolDefinitions: rejects editing a never-read file", async () => {
		await writeFile(join(dir, "d.txt"), "old");
		const tools = createAllToolDefinitions(dir, { files: createFileReadTracker() });

		await expect(
			tools.edit.execute(
				"edit",
				{ path: "d.txt", edits: [{ oldText: "old", newText: "new" }] },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(READ_BEFORE_CHANGE_MESSAGE);
		expect(await readFile(join(dir, "d.txt"), "utf8")).toBe("old");
	});

	it("createAllToolDefinitions: read, edit, then write succeeds", async () => {
		await writeFile(join(dir, "d.txt"), "old");
		const tools = createAllToolDefinitions(dir, { files: createFileReadTracker() });

		await tools.read.execute("read", { path: "d.txt" }, undefined, undefined, ctx);
		await tools.edit.execute(
			"edit",
			{ path: "d.txt", edits: [{ oldText: "old", newText: "mid" }] },
			undefined,
			undefined,
			ctx,
		);
		await tools.write.execute(
			"write",
			{ path: "d.txt", content: "new" },
			undefined,
			undefined,
			ctx,
		);
		expect(await readFile(join(dir, "d.txt"), "utf8")).toBe("new");
	});

	it("createAllTools: rejects editing a never-read file", async () => {
		await writeFile(join(dir, "d.txt"), "old");
		const tools = createAllTools(dir, { files: createFileReadTracker() });

		await expect(
			tools.edit.execute(
				"edit",
				{ path: "d.txt", edits: [{ oldText: "old", newText: "new" }] },
				undefined,
				undefined,
			),
		).rejects.toThrow(READ_BEFORE_CHANGE_MESSAGE);
	});
});

describe("read before write through AgentSession", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	it("returns the guard error to the model and leaves the file untouched", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(join(harness.tempDir, "a.txt"), "old");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "new" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("overwrite it");

		const result: ToolResultMessage = getToolResult(harness, "write");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Read before writing");
		expect(await readFile(join(harness.tempDir, "a.txt"), "utf8")).toBe("old");
	});

	it("keeps enforcing across prompts and clears after a read in the same session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(join(harness.tempDir, "a.txt"), "old");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "new" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("blocked"),
		]);
		await harness.session.prompt("try to overwrite");
		expect(getToolResult(harness, "write").isError).toBe(true);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "new" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("now do it properly");

		const result = harness.session.messages.findLast(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "write",
		);
		expect(result?.isError).not.toBe(true);
		expect(await readFile(join(harness.tempDir, "a.txt"), "utf8")).toBe("new");
	});

	it("accepts the write after the model reads the file", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await writeFile(join(harness.tempDir, "a.txt"), "old");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "new" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read then write");

		const result: ToolResultMessage = getToolResult(harness, "write");
		expect(result.isError).not.toBe(true);
		expect(await readFile(join(harness.tempDir, "a.txt"), "utf8")).toBe("new");
	});
});
