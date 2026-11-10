import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveProviderBaseUrl } from "../src/core/custom-provider.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { FileAuthStorageBackend } from "../src/core/vault.ts";
import { writeFileAtomicSync } from "../src/utils/atomic-write.ts";

// Inode
function inode(path: string): number {
	return statSync(path).ino;
}

describe("atomic config writes", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gama-atomic-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writeFileAtomicSync replaces the file without leaving a temp file", () => {
		const path = join(dir, "data.json");
		writeFileSync(path, "old", { mode: 0o640 });
		const before = inode(path);

		writeFileAtomicSync(path, "new");

		expect(readFileSync(path, "utf-8")).toBe("new");
		expect(inode(path)).not.toBe(before);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(readdirSync(dir)).toEqual(["data.json"]);
	});

	it("a failed replace keeps the target and removes the temp file", () => {
		const target = join(dir, "target-dir");
		mkdirSync(target);

		expect(() => writeFileAtomicSync(target, "new")).toThrow();

		expect(statSync(target).isDirectory()).toBe(true);
		expect(readdirSync(dir)).toEqual(["target-dir"]);
	});

	it("auth.json is replaced atomically with mode 0600", () => {
		const authPath = join(dir, "auth.json");
		const backend = new FileAuthStorageBackend(authPath);
		backend.withLock(() => ({ result: undefined, next: '{"a":1}' }));
		const before = inode(authPath);

		backend.withLock(() => ({ result: undefined, next: '{"a":2}' }));

		expect(readFileSync(authPath, "utf-8")).toBe('{"a":2}');
		expect(inode(authPath)).not.toBe(before);
		if (process.platform !== "win32") expect(statSync(authPath).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("trust.json is replaced atomically", () => {
		const store = new ProjectTrustStore(dir);
		const project = join(dir, "project");
		mkdirSync(project);
		store.set(project, true);
		const before = inode(join(dir, "trust.json"));

		store.set(project, false);

		expect(store.get(project)).toBe(false);
		expect(inode(join(dir, "trust.json"))).not.toBe(before);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("models.json is replaced atomically", async () => {
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, "{}\n");
		const before = inode(modelsPath);

		await saveProviderBaseUrl(modelsPath, "p", "https://example.test/v1");

		expect(JSON.parse(readFileSync(modelsPath, "utf-8"))).toEqual({
			providers: { p: { baseUrl: "https://example.test/v1" } },
		});
		expect(inode(modelsPath)).not.toBe(before);
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
});
