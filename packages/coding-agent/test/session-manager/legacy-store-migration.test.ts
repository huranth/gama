import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function legacyDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

describe("legacy session store migration", () => {
	it("moves per-cwd jsonl sessions into the flat gama store", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gama-legacy-sessions-"));
		tempDirs.push(tempDir);
		const agentDir = join(tempDir, "agent");
		const cwd = join(tempDir, "project");
		const legacyDir = join(agentDir, "sessions", legacyDirName(cwd));
		mkdirSync(legacyDir, { recursive: true });

		const sessionId = "01a1059e-fc71-75e1-9d49-8804c2edb6b8";
		writeFileSync(
			join(legacyDir, `2026-10-04T06-34-27-827Z_${sessionId}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-10-04T06:34:27.827Z",
				cwd,
			})}\n${JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-10-04T06:34:27.900Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
					timestamp: 1791086067900,
				},
			})}\n`,
		);

		const sessionDir = getDefaultSessionDir(cwd, agentDir);
		expect(sessionDir).toBe(join(agentDir, "sessions"));

		const files = readdirSync(sessionDir);
		expect(files).toEqual([`${sessionId}.gama`]);

		const lines = readFileSync(join(sessionDir, files[0]!))
			.toString()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ $gama: "session", id: sessionId, cwd });
		expect(lines[1]).toMatchObject({ type: "message", id: "entry-1" });

		expect(existsSync(legacyDir)).toBe(false);
	});
});
