#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const RELEASE_TARGET = process.argv[2];

const BUMP_TYPES = new Set(["major", "minor", "patch"]);

const cliPackageName = "@huranth/gama-harness";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function commandForPlatform(command) {
	if (process.platform !== "win32" || command.endsWith(".exe")) return command;
	if (command === "npm" || command === "npx") return `${command}.cmd`;
	return command;
}

function resolveBash() {
	if (process.platform !== "win32") return "bash";
	const candidates = [
		process.env.BASH,
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
		"C:\\msys64\\usr\\bin\\bash.exe",
	];
	return candidates.find((candidate) => candidate && existsSync(candidate)) ?? "bash";
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const useShell = process.platform === "win32" && (command === "npm" || command === "npx");
	const result = spawnSync(commandForPlatform(command), args, {
		encoding: "utf8",
		shell: useShell,
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const reason = `Command failed: ${command} ${args.join(" ")}`;
		throw new Error(output ? `${reason}\n${output}` : reason);
	}

	return result;
}

function getVersion() {
	const versions = findPackageDirectories()
		.map((directory) => {
			try {
				const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf-8"));
				return typeof pkg.version === "string" ? pkg.version : undefined;
			} catch {
				return undefined;
			}
		})
		.filter((version) => version !== undefined);
	return versions.sort(compareVersions).at(-1) ?? "0.0.0";
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const viewArgs = ["view", packageName, "version", "--json"];
		const result = spawnSync(npm, viewArgs, {
			encoding: "utf8",
			shell: process.platform === "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		const reason = `Failed to query npm registration for ${packageName}`;
		throw new Error(output ? `${reason}\n${output}` : reason);
	}

	if (unregisteredPackages.length > 0) {
		const listing = unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n");
		throw new Error(
			"The following public workspace packages are not registered on npm:\n" +
				`${listing}\nRegister them before running a release.`,
		);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		const label = removed === 1 ? "entry" : "entries";
		console.log(`Removed ${removed} stale workspace package lock ${label}.`);
	}
}

function stageChangedFiles() {
	const output = run(
		"git",
		["ls-files", "-m", "-o", "-d", "--exclude-standard"],
		{ capture: true }
	).stdout;
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	const staged = spawnSync("git", ["add", "--", ...paths], { stdio: "inherit" });
	if (staged.status !== 0) {
		console.error("Command failed: git add");
		process.exit(1);
	}
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run("npm", ["run", `version:${target}`]);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(
				`Error: explicit version ${target} must be greater than current version ` +
					`${currentVersion}.`,
			);
			process.exit(1);
		}

		console.log(`Setting explicit version (${target})...`);
		run("npm", ["version", target, "-w", cliPackageName, "--no-git-tag-version", "--no-workspaces-update"]);
		run(process.execPath, ["scripts/sync-versions.js"]);
		run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
	}

	removeStaleWorkspaceLockEntries();
	run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
	run("npm", ["ci", "--ignore-scripts"]);
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

console.log("\n=== Release Script ===\n");

console.log("Checking for uncommitted changes...");

const status = run("git", ["status", "--porcelain"], { capture: true }).stdout;
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

assertPackagesAreRegisteredWithNpm();

const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

console.log("Regenerating release artifacts...");
run("npm", ["run", "install-lock"]);
console.log();

console.log("Running checks...");
run("npm", ["run", "check"]);
console.log();

console.log("Building packages for tests...");
run("npm", ["run", "build:offline"]);
console.log();

console.log("Running tests...");
	run(resolveBash(), ["scripts/run-tests.sh"]);
console.log();

// Build once
console.log("Building the public release...");
run("npm", ["run", "build:public-release"]);
console.log();

console.log("Checking the packed coding-agent consumer install...");
run("npm", ["run", "check:package-install"]);
console.log();

// Commit first
console.log("Committing and tagging...");
stageChangedFiles();
run("git", ["commit", "-m", `Release v${version}`]);
run("git", ["tag", `v${version}`]);
console.log();

console.log("Publishing the public release...");

const publish = spawnSync(process.execPath, ["scripts/publish.mjs"], { stdio: "inherit" });
if (publish.status !== 0) {
	console.error("\nPublish failed after the release commit and tag were created locally.");
	console.error(`Recovery: commit and tag v${version} exist locally. Fix the cause, re-run`);
	console.error("  node scripts/publish.mjs   (safe to repeat), then push the branch and tag.");
	console.error("Do not re-run release.mjs: it would bump the version again.");
	process.exit(1);
}
console.log();

console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

console.log("Committing changelog updates...");
stageChangedFiles();
run("git", ["commit", "-m", "Add [Unreleased] section for next cycle"]);
console.log();

console.log("Pushing to remote...");

const remotes = run("git", ["remote"], { capture: true }).stdout.trim();
if (remotes) {
	const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true }).stdout.trim();
	run("git", ["push", "origin", branch]);
	run("git", ["push", "origin", `v${version}`]);
} else {
	console.log("  No git remote configured; skipping push");
}
console.log();

console.log(`=== Released v${version} ===`);
