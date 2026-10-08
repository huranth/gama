import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@huranth/gama-ai";
import { fauxAssistantMessage } from "@huranth/gama-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	SessionManager,
} from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const CANARY = "__gama_append_only_canary__";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function rawLines(content: string): string[] {
	const all = content.split("\n");
	if (all.at(-1) === "") all.pop();
	return all;
}

function parseLine(line: string): FileEntry | null {
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

function messageText(entry: FileEntry | null): string {
	if (!entry || entry.type !== "message") return "";
	const message = entry.message as { content?: string | Array<{ type: string; text?: string }> };
	const content = message.content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

describe("session context edit append-only persistence", () => {
	const tempDirs: string[] = [];
	let harness: Harness | undefined;

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "gama-append-only-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("appends context edits without rewriting persisted history", () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, join(dir, "sessions"));
		const file = session.getSessionFile()!;

		const userId = session.appendMessage({
			role: "user",
			content: "request",
			timestamp: Date.now(),
		});
		const assistantId = session.appendMessage(assistant("partial"));
		const resultId = session.appendMessage(toolResult("raw output"));

		const base = readFileSync(file, "utf8");
		const baseLines = rawLines(base);
		const header = parseLine(baseLines[0]);
		expect(header).toMatchObject({ type: "session", version: CURRENT_SESSION_VERSION });
		expect(baseLines).toHaveLength(4);

		// Canary.
		appendFileSync(file, `${CANARY}\n`);
		let snapshot = readFileSync(file, "utf8");
		const canaryIndex = rawLines(snapshot).indexOf(CANARY);
		expect(canaryIndex).toBe(baseLines.length);

		const branchBefore = session.getBranch().map((entry) => entry.id);
		const editIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			editIds.push(
				session.appendContextEdit(
					i % 2 === 0 ? assistantId : resultId,
					i === 1 ? { content: "replacement" } : null,
				),
			);
			const now = readFileSync(file, "utf8");
			expect(now.startsWith(snapshot)).toBe(true);
			expect(now.length).toBeGreaterThan(snapshot.length);
			snapshot = now;
		}

		const after = readFileSync(file, "utf8");
		const afterLines = rawLines(after);
		expect(afterLines[canaryIndex]).toBe(CANARY);
		expect(afterLines.slice(0, baseLines.length)).toEqual(baseLines);

		const parsed = afterLines.map(parseLine);
		const edits = parsed
			.map((entry, index) => ({ entry, index }))
			.filter(
				(item): item is { entry: FileEntry; index: number } =>
					item.entry?.type === "context_edit",
			);
		expect(edits).toHaveLength(editIds.length);
		expect(edits.map((item) => item.entry.id)).toEqual(editIds);
		for (const { entry, index } of edits) {
			if (entry.type !== "context_edit") throw new Error("expected context edit");
			expect(index).toBeGreaterThan(canaryIndex);
			const targetIndex = parsed.findIndex((candidate) => candidate?.id === entry.targetId);
			expect(targetIndex).toBeGreaterThanOrEqual(0);
			expect(targetIndex).toBeLessThan(index);
			expect([userId, assistantId, resultId]).toContain(entry.targetId);
		}

		const branchIds = session.getBranch().map((entry) => entry.id);
		expect(branchIds.slice(0, branchBefore.length)).toEqual(branchBefore);
		expect(messageText(session.getEntry(assistantId) ?? null)).toBe("partial");
		expect(session.buildSessionProjection().messages.map((message) => message.role)).toEqual([
			"user",
			"toolResult",
		]);
	});

	it("keeps history append-only across a reopen", () => {
		const dir = makeTempDir();
		const session = SessionManager.create(dir, join(dir, "sessions"));
		const file = session.getSessionFile()!;
		session.appendMessage({ role: "user", content: "request", timestamp: Date.now() });
		const assistantId = session.appendMessage(assistant("partial"));

		const base = readFileSync(file, "utf8");
		appendFileSync(file, `${CANARY}\n`);
		const withCanary = readFileSync(file, "utf8");
		expect(rawLines(withCanary).indexOf(CANARY)).toBe(rawLines(base).length);
		session.appendContextEdit(assistantId, null);

		const reopened = SessionManager.open(file);
		const reopenedContent = readFileSync(file, "utf8");
		expect(reopenedContent.startsWith(withCanary)).toBe(true);
		expect(rawLines(reopenedContent)).toContain(CANARY);

		const branchIds = session.getBranch().map((entry) => entry.id);
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual(branchIds);
		expect(messageText(reopened.getEntry(assistantId) ?? null)).toBe("partial");
		expect(reopened.buildSessionProjection().messages.map((message) => message.role)).toEqual([
			"user",
		]);

		const editTarget = branchIds.find((id) => id !== assistantId) ?? assistantId;
		reopened.appendContextEdit(editTarget, null);
		const finalContent = readFileSync(file, "utf8");
		expect(finalContent.startsWith(reopenedContent)).toBe(true);
		expect(rawLines(finalContent).indexOf(CANARY)).toBe(rawLines(withCanary).indexOf(CANARY));
	});

	it("keeps an automatically retried prompt append-only on disk", async () => {
		const dir = makeTempDir();
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			sessionManager,
		});
		harness.setResponses([fauxAssistantMessage("first answer")]);

		await harness.session.prompt("first");
		const file = sessionManager.getSessionFile()!;
		const before = readFileSync(file, "utf8");
		const branchBefore = sessionManager.getBranch().map((entry) => entry.id);

		appendFileSync(file, `${CANARY}\n`);
		const canaryIndex = rawLines(readFileSync(file, "utf8")).indexOf(CANARY);
		expect(canaryIndex).toBe(rawLines(before).length);

		harness.appendResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("second");

		const after = readFileSync(file, "utf8");
		expect(after.startsWith(before)).toBe(true);
		const afterLines = rawLines(after);
		expect(afterLines[canaryIndex]).toBe(CANARY);

		const parsed = afterLines.map(parseLine);
		const edits = parsed
			.map((entry, index) => ({ entry, index }))
			.filter(
				(item): item is { entry: FileEntry; index: number } =>
					item.entry?.type === "context_edit",
			);
		expect(edits).toHaveLength(1);

		const edit = edits[0].entry;
		if (edit.type !== "context_edit") throw new Error("expected context edit");
		const targetIndex = parsed.findIndex((entry) => entry?.id === edit.targetId);
		expect(targetIndex).toBeGreaterThan(canaryIndex);
		expect(edits[0].index).toBeGreaterThan(targetIndex);

		const target = parsed[targetIndex];
		expect(target?.type).toBe("message");
		if (target?.type !== "message" || target.message.role !== "assistant") {
			throw new Error("expected the failed attempt to stay persisted");
		}
		expect(target.message.stopReason).toBe("error");
		expect(target.message.errorMessage).toBe("overloaded_error");

		const branchAfter = sessionManager.getBranch().map((entry) => entry.id);
		expect(branchAfter.slice(0, branchBefore.length)).toEqual(branchBefore);
		expect(branchAfter.length).toBe(branchBefore.length + 4);

		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")[0]).toMatchObject({ success: true });
		expect(
			harness
				.eventsOfType("entry_appended")
				.some((event) => event.entry.type === "context_edit"),
		).toBe(true);

		const assistantTexts = harness.session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.map((message) =>
				message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
			);
		expect(assistantTexts).toEqual([["first answer"], ["recovered"]]);
	});
});
