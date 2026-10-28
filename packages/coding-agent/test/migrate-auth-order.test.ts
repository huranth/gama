import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { migrateAuthToAuthJson } from "../src/migrations.ts";

const writeAuth = vi.hoisted(() => ({ fail: false }));

vi.mock("../src/utils/atomic-write.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/utils/atomic-write.ts")>();
	return {
		...original,
		writeFileAtomicSync: (...args: Parameters<typeof original.writeFileAtomicSync>) => {
			if (writeAuth.fail) throw new Error("ENOSPC");
			original.writeFileAtomicSync(...args);
		},
	};
});

describe("migrateAuthToAuthJson", () => {
	let dir: string;
	let originalDir: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gama-migrate-auth-"));
		originalDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = dir;
	});

	afterEach(() => {
		writeAuth.fail = false;
		if (originalDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalDir;
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps apiKeys in settings.json when the auth.json write fails", () => {
		const settingsPath = join(dir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { anthropic: "k" } }));
		writeAuth.fail = true;

		expect(() => migrateAuthToAuthJson()).toThrow("ENOSPC");

		expect(JSON.parse(readFileSync(settingsPath, "utf-8")).apiKeys).toEqual({ anthropic: "k" });
	});

	it("moves apiKeys to auth.json and strips them from settings.json", () => {
		const settingsPath = join(dir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { anthropic: "k" } }));

		expect(migrateAuthToAuthJson()).toEqual(["anthropic"]);

		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))).toEqual({
			anthropic: { type: "api_key", key: "k" },
		});
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
	});
});
