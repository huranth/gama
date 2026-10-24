#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const directory = "packages/coding-agent/dist/public-release";
const manifestPath = join(directory, "package.json");
if (!existsSync(manifestPath)) {
	throw new Error("Public release missing. Run npm run build:public-release first.");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.name !== "@huranth/gama-harness") {
	throw new Error(`Unexpected public release package: ${manifest.name}`);
}
const internalDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
	name.startsWith("@huranth/"),
);
if (internalDependencies.length > 0) {
	throw new Error(`Public release depends on internal packages: ${internalDependencies.join(", ")}`);
}
const packages = [{ directory, name: manifest.name, version: manifest.version }];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex === -1 ? undefined : args[tagIndex + 1];
const unknownArgs = args.filter(
	(arg, index) =>
		arg !== "--dry-run" && arg !== "--tag" && !(tagIndex !== -1 && index === tagIndex + 1),
);

if (unknownArgs.length > 0 || (tagIndex !== -1 && !tag)) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run] [--tag <tag>]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const reason = `Command failed: ${command} ${args.join(" ")}`;
		throw new Error(output ? `${reason}\n${output}` : reason);
	}

	return result;
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const packArgs = ["pack", "--dry-run", "--ignore-scripts", "--json"];
	const result = run("npm", packArgs, { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(
		`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ` +
			`${packed.unpackedSize} bytes unpacked`,
	);
}

function isPublished(name, version) {
	const viewArgs = ["view", `${name}@${version}`, "version", "--json"];
	const result = spawnSync(commandForPlatform("npm"), viewArgs, {
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	const reason = `Failed to query ${name}@${version}`;
	throw new Error(output ? `${reason}\n${output}` : reason);
}

const canAttestProvenance = Boolean(
	process.env.ACTIONS_ID_TOKEN_REQUEST_URL || process.env.GITHUB_ACTIONS === "true",
);

const packageStates = packages.map((pkg) => {
	if (pkg.version.includes("-") && !tag) {
		throw new Error(
			`Prerelease ${pkg.name}@${pkg.version} needs an explicit --tag (for example --tag next).`,
		);
	}
	return { ...pkg, published: false, version: pkg.version };
});

console.log(
	`Publishing ${packageStates.length} gama packages` +
		`${tag ? ` under the ${tag} tag` : ""}${dryRun ? " (dry run)" : ""}\n`,
);

for (const pkg of packageStates) {
	assertBuildOutputExists(pkg.directory);
	pkg.published = isPublished(pkg.name, pkg.version);

	if (pkg.published) {
		console.log(`${pkg.name}@${pkg.version} is already published; validating package contents only.`);
	} else {
		console.log(
			`${pkg.name}@${pkg.version} is not published; validating package contents ` +
				"before publish.",
		);
	}
	validatePack(pkg.directory);
	console.log();
}

if (dryRun) {
	process.exit(0);
}

console.log("All packages validated; starting publication.\n");

for (const pkg of packageStates) {
	if (pkg.published) {
		console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
		continue;
	}

	const publishArgs = ["publish", "--access", "public", "--ignore-scripts"];
	if (tag) {
		publishArgs.push("--tag", tag);
	}
	if (canAttestProvenance) {
		publishArgs.push("--provenance");
	} else {
		console.log("Skipping provenance attestation: no CI OIDC token available.\n");
	}
	run("npm", publishArgs, { cwd: pkg.directory });
	console.log();
}
