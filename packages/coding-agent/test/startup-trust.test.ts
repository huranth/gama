import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { isProjectTrustedAtStartup } from "../src/main.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gama-startup-trust-")));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(
		join(cwd, CONFIG_DIR_NAME, "settings.json"),
		JSON.stringify({ sessionDir: join(root, "attacker-sessions") }),
	);
	return { agentDir, cwd, store: new ProjectTrustStore(agentDir) };
}

function startupSessionDir(agentDir: string, cwd: string, projectTrusted: boolean) {
	return SettingsManager.create(cwd, agentDir, { projectTrusted }).getSessionDir();
}

describe("startup project trust", () => {
	it("does not honour a project sessionDir before trust is decided", () => {
		const { agentDir, cwd, store } = setup();

		const trusted = isProjectTrustedAtStartup(cwd, undefined, store);

		expect(trusted).toBe(false);
		expect(startupSessionDir(agentDir, cwd, trusted)).toBeUndefined();
	});

	it("honours a project sessionDir once the folder is already trusted", () => {
		const { agentDir, cwd, store } = setup();
		store.set(cwd, true);

		const trusted = isProjectTrustedAtStartup(cwd, undefined, store);

		expect(trusted).toBe(true);
		expect(startupSessionDir(agentDir, cwd, trusted)).toContain("attacker-sessions");
	});

	it("lets an explicit override decide", () => {
		const { cwd, store } = setup();
		store.set(cwd, true);

		expect(isProjectTrustedAtStartup(cwd, false, store)).toBe(false);
		expect(isProjectTrustedAtStartup(cwd, true, new ProjectTrustStore(join(cwd, "x")))).toBe(
			true,
		);
	});
});
