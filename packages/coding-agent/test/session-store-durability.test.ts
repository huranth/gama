import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@huranth/gama-ai";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

// Failure mock
const failureFlags = vi.hoisted(() => ({
	failAppend: false,
	failRename: false,
}));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync(path: Parameters<typeof actual.appendFileSync>[0], data: string) {
			if (failureFlags.failAppend) {
				throw new Error("ENOSPC: no space left on device");
			}
			return actual.appendFileSync(path, data);
		},
		renameSync(from: string, to: string) {
			if (failureFlags.failRename) {
				throw new Error("EPERM: rename blocked");
			}
			return actual.renameSync(from, to);
		},
	};
});

const tempDirs: string[] = [];

beforeEach(() => {
	tempDirs.push(mkdtempSync(join(tmpdir(), "gama-durability-")));
});

afterEach(() => {
	failureFlags.failAppend = false;
	failureFlags.failRename = false;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeUserMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as unknown as Message;
}

function sessionDir(index = 0): string {
	return join(tempDirs[index]!, "sessions");
}

function readLines(path: string): string {
	return readFileSync(path, "utf8");
}

describe("session store durability", () => {
	it("recovers a torn last line left by a mid-append crash", () => {
		const manager = SessionManager.create(tempDirs[0]!, sessionDir());
		manager.appendMessage(makeUserMessage("first"));
		const file = manager.getSessionFile()!;

		// Torn line
		writeFileSync(file, readLines(file).replace(/\n$/, ""));

		const reopened = SessionManager.open(file);
		reopened.appendMessage(makeUserMessage("second"));

		const blob = readLines(file);
		const lines = blob.split("\n").filter((line) => line.trim());
		// No fusion
		expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
		expect(blob).toContain("first");
		expect(blob).toContain("second");
	});

	it("stays readable when garbage lines are injected between valid entries", () => {
		const manager = SessionManager.create(tempDirs[0]!, sessionDir());
		manager.appendMessage(makeUserMessage("before garbage"));
		const file = manager.getSessionFile()!;

		const lines = readLines(file).trimEnd().split("\n");
		writeFileSync(
			file,
			[lines[0]!, "{{{ deliberately broken json", "", lines[1]!, ""].join("\n"),
		);

		const reopened = SessionManager.open(file);
		const userTexts = reopened
			.buildSessionContext()
			.messages.filter((message) => message.role === "user")
			.map((message) => (message.content as { text?: string }[])[0]?.text);
		expect(userTexts).toContain("before garbage");

		// Skip garbage
		reopened.appendMessage(makeUserMessage("after garbage"));
		expect(() =>
			readLines(file)
				.split("\n")
				.filter((line) => line.trim() && !line.includes("deliberately broken"))
				.map((line) => JSON.parse(line)),
		).not.toThrow();
		expect(readLines(file)).toContain("after garbage");
	});

	it("keeps the disk file intact when append and rewrite both fail on disk", () => {
		const manager = SessionManager.create(tempDirs[0]!, sessionDir());
		manager.appendMessage(makeUserMessage("on-disk"));
		const file = manager.getSessionFile()!;
		const contentBefore = readLines(file);

		// Disk full
		failureFlags.failAppend = true;
		failureFlags.failRename = true;
		expect(() => manager.appendMessage(makeUserMessage("kept-in-memory"))).not.toThrow();
		expect(() => manager.appendMessage(makeUserMessage("also-in-memory"))).not.toThrow();

		// File intact
		expect(readLines(file)).toBe(contentBefore);

		// Recovered disk
		failureFlags.failAppend = false;
		failureFlags.failRename = false;
		expect(() => manager.appendMessage(makeUserMessage("recovered"))).not.toThrow();

		const blob = readLines(file);
		expect(blob).toContain("on-disk");
		expect(blob).toContain("kept-in-memory");
		expect(blob).toContain("also-in-memory");
		expect(blob).toContain("recovered");
	});

	it("rejects unsafe legacy session ids during migration instead of escaping the store", () => {
		const agentDir = tempDirs[0]!;
		const folderCwd = join(agentDir, "project");
		mkdirSync(folderCwd, { recursive: true });

		const safeDirName = `--${folderCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const legacyDir = join(agentDir, "sessions", safeDirName);
		mkdirSync(legacyDir, { recursive: true });

		writeFileSync(
			join(legacyDir, "legacy.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: `..${"\\.."}evil`,
				timestamp: new Date().toISOString(),
				cwd: folderCwd,
			})}\n`,
		);

		getDefaultSessionDir(folderCwd, agentDir);

		// Stay inside
		expect(readdirSync(join(agentDir, "sessions")).filter((f) => !f.startsWith("--"))).toEqual([
			// No escape
		]);
		const junkHeader = JSON.parse(readLines(join(legacyDir, "legacy.jsonl")));
		expect(junkHeader.id).toBe("..\\..evil");
	});

	it("migrates a valid legacy session fully and exactly once", () => {
		const agentDir = tempDirs[0]!;
		const folderCwd = join(agentDir, "project");
		mkdirSync(folderCwd, { recursive: true });

		const safeDirName = `--${folderCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const legacyDir = join(agentDir, "sessions", safeDirName);
		mkdirSync(legacyDir, { recursive: true });

		writeFileSync(
			join(legacyDir, "ok.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "migration-source-id",
				timestamp: new Date().toISOString(),
				cwd: folderCwd,
			})}\n${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: makeUserMessage("legacy message"),
			})}\n`,
		);

		getDefaultSessionDir(folderCwd, agentDir);

		const target = join(agentDir, "sessions", "migration-source-id.gama");
		const blob = readLines(target);
		expect(blob).toContain("legacy message");
		// Source gone
		expect(existsSync(legacyDir)).toBe(false);

		// Idempotent run
		getDefaultSessionDir(folderCwd, agentDir);
		const content = readLines(target);
		expect(content.split("\n").filter((line) => line.trim()).length).toBe(2);
	});

	it("refuses to touch a non-session file pointed at by --session", () => {
		const file = join(tempDirs[0]!, "junk.gama");
		const original = '\n{\n"partial json\n';
		writeFileSync(file, original);

		expect(() => SessionManager.open(file)).toThrow(/not a valid gama session/);
		expect(readLines(file)).toBe(original);
	});

	it("never truncates an existing file when an atomic rewrite fails", () => {
		const manager = SessionManager.create(tempDirs[0]!, sessionDir());
		manager.appendMessage(makeUserMessage("survives"));

		const headerLine = {
			type: "session",
			version: 1,
			id: "v1-session",
			timestamp: new Date().toISOString(),
			cwd: tempDirs[0]!,
		};
		const v1File = join(sessionDir(), "v1-session.gama");
		writeFileSync(
			v1File,
			`${JSON.stringify(headerLine)}\n${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: makeUserMessage("v1 message"),
			})}\n`,
		);

		// Blocked rename
		failureFlags.failRename = true;
		const before = readLines(v1File);
		expect(() => SessionManager.open(v1File)).toThrow();
		// Original intact
		expect(readLines(v1File)).toBe(before);
	});
});
