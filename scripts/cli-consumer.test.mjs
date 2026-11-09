import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	installCodingAgentConsumer,
	packReleasePackages,
	smokeTestCodingAgentConsumer,
} from "./cli-consumer.mjs";

const codingAgentName = "@huranth/gama-harness";

function createFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "gama-consumer-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packages = [codingAgentName, "@huranth/gama-bus"].map((name) => ({
		name,
		directory: join(root, "packages", name.split("/")[1]),
	}));
	for (const pkg of packages) {
		const isAgent = pkg.name === codingAgentName;
		const manifest = {
			name: pkg.name,
			version: "1.0.0",
			type: "module",
			exports: isAgent
				? {
						".": "./dist/index.js",
					}
				: "./dist/index.js",
			...(isAgent
				? {
						bin: { gama: "dist/bundle/cli.js" },
						dependencies: { "@huranth/gama-bus": "1.0.0" },
					}
				: {}),
		};
		const files = {
			"package.json": JSON.stringify(manifest),
			"dist/index.js": isAgent
				? `

import { marker } from "@huranth/gama-bus";
if (marker !== "local tarball") throw new Error("Wrong Chord artifact");

export function createAgentSession() {}

export class SessionStore { static inMemory() {} }

export class ModelHub { static create() {} }
`
				: 'export const marker = "local tarball";',
			...(isAgent
				? {
						"dist/cli.js": 'console.log("1.0.0");',
						"dist/bundle/cli.js": 'console.log("1.0.0");',
					}
				: {}),
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(pkg.directory, path)), { recursive: true });
			writeFileSync(join(pkg.directory, path), content);
		}
	}
	const tarballs = packReleasePackages(packages, join(root, "tarballs"));
	const directory = join(root, "consumer");
	installCodingAgentConsumer(directory, tarballs);
	return directory;
}

test(
	"installs only coding-agent directly and overrides only its declared runtime dependencies",
	(t) => {
	const directory = createFixture(t);
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), [codingAgentName]);
	const overrides = Object.keys(manifest.overrides).sort();
	assert.deepEqual(overrides, [codingAgentName, "@huranth/gama-bus"].sort());
	smokeTestCodingAgentConsumer(directory);
});

test("fails when the published package contains development-only code", (t) => {
	const directory = createFixture(t);
	const experimental = join(directory, "node_modules", codingAgentName, "dist/experimental");
	mkdirSync(experimental);
	assert.throws(() => smokeTestCodingAgentConsumer(directory), /contains development-only code/);
});
