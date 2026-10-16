import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("issue #2791 fs.watch error event crashes process", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "gama-2791-"));
		const agentDir = join(tempRoot, "agent");
		const themesDir = join(agentDir, "themes");
		mkdirSync(themesDir, { recursive: true });

		const darkThemePath = join(__dirname, "../../../src/modes/tui/theme/dark.json");
		const darkTheme = JSON.parse(readFileSync(darkThemePath, "utf-8"));
		darkTheme.name = "custom-test";
		writeFileSync(join(themesDir, "custom-test.json"), JSON.stringify(darkTheme, null, 2));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("process should survive an error event on the theme FSWatcher", () => {
		const themeModulePath = pathToFileURL(
			join(__dirname, "../../../src/modes/tui/theme/theme.ts"),
		).href;
		const agentDir = join(tempRoot, "agent").replace(/\\/g, "/");

		const scriptPath = join(tempRoot, "test-watcher-error.mts");
		writeFileSync(
			scriptPath,
			`
import { setTheme, stopThemeWatcher } from "${themeModulePath}";

process.env.GAMA_CODING_AGENT_DIR = "${agentDir}";

setTheme("custom-test", true);

const handles = (process as any)._getActiveHandles();
const fsWatcher = handles.find((h: any) => h.constructor?.name === "FSWatcher");

if (!fsWatcher) {
	process.stderr.write("no FSWatcher found among active handles\\n");
	process.exit(2);
}

const errorListenerCount = fsWatcher.listenerCount("error");
if (errorListenerCount === 0) {
	process.stderr.write("BUG: FSWatcher has no error handler (issue #2791)\\n");
}

try {
	fsWatcher.emit("error", new Error("simulated OS watcher failure"));
} catch {
	process.stderr.write("error event was unhandled and threw\\n");
	process.exit(1);
}

stopThemeWatcher();
process.exit(0);
`,
		);

		let _stdout = "";
		let stderr = "";
		let exitCode: number;
		try {
			_stdout = execFileSync(process.execPath, [scriptPath], {
				timeout: 10000,
				encoding: "utf-8",
				env: { ...process.env, GAMA_CODING_AGENT_DIR: agentDir },
				stdio: ["pipe", "pipe", "pipe"],
			});
			exitCode = 0;
		} catch (err: unknown) {
			const e = err as { status: number; stdout: string; stderr: string };
			_stdout = e.stdout ?? "";
			stderr = e.stderr ?? "";
			exitCode = e.status ?? 1;
		}

		expect(exitCode, `Child crashed (exit ${exitCode}). stderr: ${stderr.trim()}`).toBe(0);
	});
});
