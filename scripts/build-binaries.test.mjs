import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const script = resolve(repoRoot, "scripts/build-binaries.sh");

it("refuses to delete the repository root", () => {
	const result = spawnSync(
		"bash",
		[script, "--skip-install", "--skip-build", "--out", "."],
		{ cwd: repoRoot, encoding: "utf8" },
	);
	const output = `${result.stdout}${result.stderr}`;

	assert.notEqual(result.status, 0);
	assert.match(output, /Refusing to use/);
});
