#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const codingAgentName = "@huranth/gama-harness";

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
function needsShell(command) {
	return process.platform === "win32" && PACKAGE_MANAGERS.has(command);
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		shell: needsShell(command),
		timeout: 300_000,
		...options,
	});
	if (result.status !== 0) {
		const head = `Command failed: ${command} ${args.join(" ")}`;
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`;
		throw new Error(`${head}\n${output}`);
	}
	return result.stdout;
}

export function packReleasePackages(packages, tarballDirectory) {
	mkdirSync(tarballDirectory, { recursive: true });
	const tarballs = new Map();
	for (const pkg of packages) {
		const manifest = JSON.parse(readFileSync(join(pkg.directory, "package.json"), "utf8"));
		if (manifest.name !== pkg.name) throw new Error(`Unexpected package name in ${pkg.directory}`);
		const args = ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory];
		const output = run("npm", args, { cwd: pkg.directory });
		const parsed = JSON.parse(output);
		const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
		tarballs.set(pkg.name, join(tarballDirectory, packed.filename));
	}
	return tarballs;
}

export function installCodingAgentConsumer(directory, tarballs, packageManager = "npm") {
	mkdirSync(directory, { recursive: true });
	const overrides = Object.fromEntries([...tarballs].map(([name, path]) => [
		name, `file:./${relative(directory, path).replaceAll("\\", "/")}`,
	]));
	if (!overrides[codingAgentName]) throw new Error("Missing coding-agent tarball");
	const manifest = {
		private: true,
		dependencies: { [codingAgentName]: overrides[codingAgentName] },
		overrides,
	};
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	const installArgs = ["--omit=dev", "--no-audit", "--no-fund"];
	const args = packageManager === "bun" ? ["--production"] : installArgs;
	run(packageManager, ["install", "--ignore-scripts", ...args], { cwd: directory });
}

export function smokeTestCodingAgentConsumer(directory, runtime = process.execPath) {
	const packageDir = join(directory, "node_modules", codingAgentName);
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const forbiddenPaths = [
		"dist/client",
		"dist/experimental",
		"dist/cli/experimental",
		"dist/bundle/client.js",
		"dist/bundle/coordinator.js",
	];
	for (const path of forbiddenPaths) {
		if (existsSync(join(packageDir, path))) {
			throw new Error(`Published package contains development-only code: ${path}`);
		}
	}
	const home = mkdtempSync(join(directory, "smoke-home-"));
	const entry = join(directory, "smoke-sdk.mjs");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: home,
		LOCALAPPDATA: home,
		XDG_CONFIG_HOME: home,
		XDG_CACHE_HOME: home,
		GAMA_CODING_AGENT_DIR: join(home, ".gama", "agent"),
		GAMA_OFFLINE: "1",
		GAMA_TELEMETRY: "0",
	};
	for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	try {
		writeFileSync(entry, `import assert from "node:assert/strict";
import { createAgentSession, SessionManager, ModelRuntime } from "${codingAgentName}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof SessionManager.inMemory, "function");
assert.equal(typeof ModelRuntime.create, "function");
`);
		run(runtime, [entry], { cwd: directory, env, timeout: 30_000 });
		// The public release ships only the bundled bin, not the unbundled dist/cli.js.
		const cli = manifest.bin.gama;
		const output = run(runtime, [join(packageDir, cli), "--version"], { cwd: directory, env, timeout: 30_000 });
		if (output.trim() !== manifest.version) {
			throw new Error(`Unexpected version from ${cli}: ${output}`);
		}
	} finally {
		rmSync(entry, { force: true });
		rmSync(home, { recursive: true, force: true });
	}
	console.log(`Coding-agent SDK and CLI consumer smoke tests passed (${runtime}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("Usage: node scripts/coding-agent-consumer.mjs");
	const root = mkdtempSync(join(tmpdir(), "gama-package-consumer-"));
	try {
		// The dev package depends on private workspace packages; only the bundled
		// public release is what gets published, so pack that when it was built.
		const packages = getPublicWorkspacePackages().map((pkg) => {
			const release = join(pkg.directory, "dist", "public-release");
			if (pkg.name !== codingAgentName || !existsSync(join(release, "package.json"))) return pkg;
			return { ...pkg, directory: release };
		});
		const tarballs = packReleasePackages(packages, join(root, "tarballs"));
		const directory = join(root, "consumer");
		installCodingAgentConsumer(directory, tarballs);
		smokeTestCodingAgentConsumer(directory);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
