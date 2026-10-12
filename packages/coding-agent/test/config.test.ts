import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	findNodePackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getUpdateInstruction,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalGamaPackageDir = process.env.GAMA_PACKAGE_DIR;
const originalArgv1 = process.argv[1];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalGamaPackageDir === undefined) {
		delete process.env.GAMA_PACKAGE_DIR;
	} else {
		process.env.GAMA_PACKAGE_DIR = originalGamaPackageDir;
	}
	if (originalArgv1 === undefined) {
		process.argv.splice(1, 1);
	} else {
		process.argv[1] = originalArgv1;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(
	template = "gama-prefix-",
	useLibDir = true,
): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = useLibDir ? join(prefix, "lib", "node_modules") : join(prefix, "node_modules");
	const scopeDir = join(root, "@huranth");
	const packageDir = join(scopeDir, "gama-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.GAMA_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "gama-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@huranth", "gama-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
		createFakePnpmScript(root),
	);
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.GAMA_PACKAGE_DIR = packageDir;
	setExecPath(
		join(
			root,
			".pnpm",
			"@huranth+gama-coding-agent@0.0.0",
			"node_modules",
			"@huranth",
			"gama-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "gama-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@huranth", "gama-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"),
		createFakeYarnScript(globalDir),
	);
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.GAMA_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@huranth", "gama-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "gama-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@huranth");
	const packageDir = join(scopeDir, "gama-coding-agent");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(
		join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"),
		createFakeBunScript(bunBin),
	);
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.GAMA_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%~1"=="root" if "%~2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%~1"=="global" if "%~2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%~1"=="pm" if "%~2"=="bin" if "%~3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("findNodePackageDir", () => {
	test("skips binary metadata copied into dist", () => {
		tempDir = mkdtempSync(join(tmpdir(), "gama-package-dir-"));
		const distDir = join(tempDir, "dist");
		const bundleDir = join(distDir, "bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), "{}");
		writeFileSync(join(distDir, "package.json"), "{}");

		expect(findNodePackageDir(bundleDir)).toBe(tempDir);
	});
});

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@huranth+gama-coding-agent@0.67.68\\node_modules\\@huranth\\gama-coding-agent\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@huranth/gama-coding-agent")).toBe(
			"Run: pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @huranth/gama-coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("@huranth/gama-coding-agent")).toBeUndefined();
		expect(getUpdateInstruction("@huranth/gama-coding-agent")).toBe(
			"Update @huranth/gama-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@huranth/gama-coding-agent");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@huranth/gama-coding-agent",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @huranth/gama-coding-agent`,
		});
	});

	test("self-updates exact npm versions without uninstalling the current package", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@huranth/gama-coding-agent", undefined, {
			packageName: "@huranth/gama-coding-agent",
			installSpec: "@huranth/gama-coding-agent@1.2.3",
		});

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@huranth/gama-coding-agent@1.2.3",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @huranth/gama-coding-agent@1.2.3`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand(
			"@huranth/gama-coding-agent",
			undefined,
			"@new-scope/gama",
		);

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@new-scope/gama",
			],
			display: `npm --prefix ${prefix} uninstall -g @huranth/gama-coding-agent && npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/gama`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@huranth/gama-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @huranth/gama-coding-agent`,
				},
				{
					command: "npm",
					args: [
						"--prefix",
						prefix,
						"install",
						"-g",
						"--ignore-scripts",
						"--min-release-age=0",
						"@new-scope/gama",
					],
					display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @new-scope/gama`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall("gama-prefix-", process.platform !== "win32");

		const command = getSelfUpdateCommand("@huranth/gama-coding-agent", [
			"npm",
			"--prefix",
			prefix,
		]);

		expect(command).toEqual({
			command: "npm",
			args: [
				"--prefix",
				prefix,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				"@huranth/gama-coding-agent",
			],
			display: `npm --prefix ${prefix} install -g --ignore-scripts --min-release-age=0 @huranth/gama-coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@huranth/gama-coding-agent", []);

		expect(command?.args).toEqual([
			"--prefix",
			prefix,
			"install",
			"-g",
			"--ignore-scripts",
			"--min-release-age=0",
			"@huranth/gama-coding-agent",
		]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("gama prefix ");

		const command = getSelfUpdateCommand("@huranth/gama-coding-agent");

		expect(command?.display).toBe(
			`npm --prefix "${prefix}" install -g --ignore-scripts --min-release-age=0 @huranth/gama-coding-agent`,
		);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@huranth\\gama-coding-agent";
		process.env.GAMA_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@huranth/gama-coding-agent")).toBe(
			"Run: npm install -g --ignore-scripts --min-release-age=0 @huranth/gama-coding-agent",
		);
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@huranth/gama-coding-agent");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: [
				"install",
				"-g",
				"--ignore-scripts",
				"--minimum-release-age=0",
				"@huranth/gama-coding-agent",
			],
			display:
				"bun install -g --ignore-scripts --minimum-release-age=0 @huranth/gama-coding-agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the " + "old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand(
			"@huranth/gama-coding-agent",
			undefined,
			"@new-scope/gama",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: [
				"install",
				"-g",
				"--ignore-scripts",
				"--config.minimumReleaseAge=0",
				"@new-scope/gama",
			],
			display:
				"pnpm remove -g @huranth/gama-coding-agent && pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/gama",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@huranth/gama-coding-agent"],
					display: "pnpm remove -g @huranth/gama-coding-agent",
				},
				{
					command: "pnpm",
					args: [
						"install",
						"-g",
						"--ignore-scripts",
						"--config.minimumReleaseAge=0",
						"@new-scope/gama",
					],
					display:
						"pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @new-scope/gama",
				},
			],
		});
	});

	test("self-updates pnpm v11 global installs resolved through the store", () => {
		const temp = mkdtempSync(join(tmpdir(), "gama-pnpm11-"));
		const binDir = join(temp, "bin");
		const root = join(temp, "Library", "pnpm", "global", "v11");
		const packageName = "@huranth/gama-coding-agent";
		const globalPackageDir = join(root, "11e9a", "node_modules", "@huranth", "gama-coding-agent");
		const storePackageDir = join(
			temp,
			"Library",
			"pnpm",
			"store",
			"v11",
			"links",
			"@huranth",
			"gama-coding-agent",
			"0.75.0",
			"hash",
			"node_modules",
			"@huranth",
			"gama-coding-agent",
		);
		mkdirSync(globalPackageDir, { recursive: true });
		mkdirSync(storePackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(globalPackageDir, "package.json"), "{}");
		writeFileSync(
			join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
			createFakePnpmScript(root),
		);
		chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
		tempDir = temp;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		process.env.GAMA_PACKAGE_DIR = storePackageDir;
		process.argv[1] = join(globalPackageDir, "dist", "cli.js");
		setExecPath(join(storePackageDir, "dist", "cli.js"));

		const command = getSelfUpdateCommand(packageName);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", packageName],
			display: `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${packageName}`,
		});
	});

	test("self-updates renamed yarn global installs by removing the " + "old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand(
			"@huranth/gama-coding-agent",
			undefined,
			"@new-scope/gama",
		);

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "--ignore-scripts", "@new-scope/gama"],
			display:
				"yarn global remove @huranth/gama-coding-agent && yarn global add --ignore-scripts @new-scope/gama",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@huranth/gama-coding-agent"],
					display: "yarn global remove @huranth/gama-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "--ignore-scripts", "@new-scope/gama"],
					display: "yarn global add --ignore-scripts @new-scope/gama",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand(
			"@huranth/gama-coding-agent",
			undefined,
			"@new-scope/gama",
		);

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", "@new-scope/gama"],
			display:
				"bun uninstall -g @huranth/gama-coding-agent && bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/gama",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@huranth/gama-coding-agent"],
					display: "bun uninstall -g @huranth/gama-coding-agent",
				},
				{
					command: "bun",
					args: [
						"install",
						"-g",
						"--ignore-scripts",
						"--minimum-release-age=0",
						"@new-scope/gama",
					],
					display: "bun install -g --ignore-scripts --minimum-release-age=0 @new-scope/gama",
				},
			],
		});
	});

	test.skipIf(process.platform === "win32")(
		"does not self-update when npm install path is not writable",
		() => {
			const { packageDir } = createNpmPrefixInstall();
			chmodSync(packageDir, 0o500);

			expect(getSelfUpdateCommand("@huranth/gama-coding-agent")).toBeUndefined();
			expect(getSelfUpdateUnavailableInstruction("@huranth/gama-coding-agent")).toContain(
				"the install path is not writable",
			);
		},
	);
});
