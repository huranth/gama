import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/core/sessions.ts";

const AGENT_DIR_ENV = "GAMA_CODING_AGENT_DIR";

describe("SessionStore.listAll default layout", () => {
	let tempDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "gama-session-list-"));
		previousAgentDir = process.env[AGENT_DIR_ENV];
		process.env[AGENT_DIR_ENV] = join(tempDir, "agent");
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previousAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("finds sessions stored directly in the default sessions directory", async () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
		const session = SessionStore.create(projectDir, join(tempDir, "agent", "sessions"));
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		const sessionPath = session.getSessionFile();
		expect(sessionPath).toBeDefined();

		const all = await SessionStore.listAll();
		expect(all.map((item) => item.path)).toContain(sessionPath);
	});
});
