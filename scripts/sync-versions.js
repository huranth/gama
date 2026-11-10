#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const generatedSuffixes = [join("cli", "install-lock")];

const cliPackageName = "@huranth/gama-harness";

const packageRoot = process.argv[2] ?? "packages";

const workspacePackages = findPackageDirectories(packageRoot)
	.filter((directory) => !generatedSuffixes.some((suffix) => directory.endsWith(suffix)))
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	});

const cliPackage = workspacePackages.find((pkg) => pkg.data.name === cliPackageName);
if (!cliPackage) {
	console.error(`\nERROR: ${cliPackageName} was not found under ${packageRoot}.`);
	process.exit(1);
}

const cliVersion = cliPackage.data.version;
console.log(`Workspaces follow ${cliPackageName} ${cliVersion}.`);

let totalUpdates = 0;
const dirtyPackages = new Set();

for (const pkg of workspacePackages) {
	if (pkg.data.version !== cliVersion) {
		console.log(`\n${pkg.data.name}: version ${pkg.data.version} -> ${cliVersion}`);
		pkg.data.version = cliVersion;
		totalUpdates++;
		dirtyPackages.add(pkg);
	}

	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			if (!dependencyName.startsWith("@huranth/")) {
				continue;
			}
			const newSpecifier = `^${cliVersion}`;
			if (currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} -> ${newSpecifier}` +
					(dependencyType === "devDependencies" ? " (devDependencies)" : ""),
			);
			dependencies[dependencyName] = newSpecifier;
			totalUpdates++;
			dirtyPackages.add(pkg);
		}
	}
}

for (const pkg of dirtyPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\nAll workspace versions and dependency ranges match.");
} else {
	console.log(`\nUpdated ${totalUpdates} version or range.`);
}
