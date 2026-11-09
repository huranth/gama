import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.GAMA_LOCAL_RELEASE_IMPORT_ONLY = "1";

const { prepareOutputDirectory } = await import("./local-release.mjs");

test("rejects an output directory that contains the repository", () => {
	const sandbox = mkdtempSync(join(tmpdir(), "gama-local-release-test-"));
	const repository = join(sandbox, "repository");
	mkdirSync(repository);

	try {
		assert.throws(
			() => prepareOutputDirectory({ outDir: sandbox, force: true }, repository),
			/must not contain the repository/,
		);
		assert.equal(existsSync(repository), true);
	} finally {
		rmSync(sandbox, { force: true, recursive: true });
	}
});
