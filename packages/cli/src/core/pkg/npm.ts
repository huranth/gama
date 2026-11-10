import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gt, maxSatisfying, rcompare, satisfies } from "semver";
import { writeFileAtomicSync } from "../../utils/atomic-write.ts";
import { markPathIgnoredByCloudSync } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { isOfflineModeEnabled, NETWORK_TIMEOUT_MS } from "../resource-scan.ts";
import { ensureGitIgnore, getManagedNpmPath, getNpmRoot } from "./dirs.ts";
import type { InstalledSourceScope, NpmSource, PackageContext, SourceScope } from "./types.ts";

export function getNpmCommand(ctx: PackageContext): { command: string; args: string[] } {
	const configuredCommand = ctx.settings.getNpmCommand();
	if (!configuredCommand || configuredCommand.length === 0) {
		return { command: "npm", args: [] };
	}
	const [command, ...args] = configuredCommand;
	if (!command) {
		throw new Error("Invalid npmCommand");
	}
	return { command, args };
}

export function getPackageManagerName(ctx: PackageContext): string {
	const npmCommand = getNpmCommand(ctx);
	const normalizeCommandName = (command: string): string =>
		basename(command).replace(/\.(cmd|exe)$/i, "");
	const supportedPackageManagers = new Set(["npm", "pnpm", "bun"]);
	const directCommand = normalizeCommandName(npmCommand.command);
	const separatorIndex = npmCommand.args.lastIndexOf("--");
	if (separatorIndex >= 0) {
		const wrappedCommand = npmCommand.args[separatorIndex + 1];
		return wrappedCommand ? normalizeCommandName(wrappedCommand) : directCommand;
	}
	if (supportedPackageManagers.has(directCommand)) return directCommand;

	const wrappedPackageManagers = [
		...new Set(
			npmCommand.args
				.map(normalizeCommandName)
				.filter((command) => supportedPackageManagers.has(command)),
		),
	];
	if (wrappedPackageManagers.length > 1) {
		throw new Error(`Ambiguous command: ${wrappedPackageManagers.join(", ")}`);
	}
	return wrappedPackageManagers[0] ?? directCommand;
}

export async function runNpmCommand(
	ctx: PackageContext,
	args: string[],
	options?: { cwd?: string },
): Promise<void> {
	const npmCommand = getNpmCommand(ctx);
	await ctx.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
}

export function runNpmCommandSync(ctx: PackageContext, args: string[]): string {
	const npmCommand = getNpmCommand(ctx);
	return ctx.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
}

export function getNpmInstallArgs(
	ctx: PackageContext,
	specs: string[],
	installRoot: string,
): string[] {
	const packageManagerName = getPackageManagerName(ctx);
	if (packageManagerName === "bun") {
		return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
	}
	if (packageManagerName === "pnpm") {
		return [
			"install",
			...specs,
			"--prefix",
			installRoot,
			"--config.auto-install-peers=false",
			"--config.strict-peer-dependencies=false",
			"--config.strict-dep-builds=false",
		];
	}
	return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
}

export function getGitDependencyInstallArgs(ctx: PackageContext): string[] {
	switch (getPackageManagerName(ctx)) {
		case "bun":
			return ["install", "--omit=dev", "--omit=peer", "--ignore-scripts"];
		case "pnpm":
			return [
				"install",
				"--prod",
				"--ignore-scripts",
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		case "npm":
			return ["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts"];
		default:
			return ["install", "--ignore-scripts"];
	}
}

export function ensureNpmProject(installRoot: string): void {
	if (!existsSync(installRoot)) {
		mkdirSync(installRoot, { recursive: true });
	}
	markPathIgnoredByCloudSync(installRoot);
	ensureGitIgnore(installRoot);
	const packageJsonPath = join(installRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		const pkgJson = { name: "gama-extensions", private: true };
		writeFileAtomicSync(packageJsonPath, JSON.stringify(pkgJson, null, 2));
	}
}

export async function installNpm(
	ctx: PackageContext,
	source: NpmSource,
	scope: SourceScope,
	temporary: boolean,
): Promise<void> {
	const installRoot = getNpmRoot(ctx, scope, temporary);
	ensureNpmProject(installRoot);
	await runNpmCommand(ctx, getNpmInstallArgs(ctx, [source.spec], installRoot));
}

export async function uninstallNpm(
	ctx: PackageContext,
	source: NpmSource,
	scope: SourceScope,
): Promise<void> {
	const installRoot = getNpmRoot(ctx, scope, false);
	if (!existsSync(installRoot)) {
		return;
	}
	const packageManagerName = getPackageManagerName(ctx);
	if (packageManagerName === "bun") {
		await runNpmCommand(ctx, ["uninstall", source.name, "--cwd", installRoot]);
		return;
	}
	const args = ["uninstall", source.name, "--prefix", installRoot];
	if (packageManagerName !== "pnpm") {
		args.push("--legacy-peer-deps");
	}
	await runNpmCommand(ctx, args);
}

export async function installNpmBatch(
	ctx: PackageContext,
	specs: string[],
	scope: InstalledSourceScope,
): Promise<void> {
	const installRoot = getNpmRoot(ctx, scope, false);
	ensureNpmProject(installRoot);
	await runNpmCommand(ctx, getNpmInstallArgs(ctx, specs, installRoot));
}

export function getInstalledNpmVersion(installedPath: string): string | undefined {
	const packageJsonPath = join(installedPath, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(stripBom(content)) as { version?: string };
		return pkg.version;
	} catch {
		return undefined;
	}
}

export async function installedNpmMatchesRange(
	source: NpmSource,
	installedPath: string,
): Promise<boolean> {
	const installedVersion = getInstalledNpmVersion(installedPath);
	if (!installedVersion) {
		return false;
	}
	return source.range ? satisfies(installedVersion, source.range) : true;
}

export function getGlobalNpmRoot(ctx: PackageContext): string {
	const npmCommand = getNpmCommand(ctx);
	const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
	if (ctx.npmRoot.root && ctx.npmRoot.key === commandKey) {
		return ctx.npmRoot.root;
	}
	const root =
		getPackageManagerName(ctx) === "bun"
			? join(
					dirname(runNpmCommandSync(ctx, ["pm", "bin", "-g"]).trim()),
					"install",
					"global",
					"node_modules",
				)
			: runNpmCommandSync(ctx, ["root", "-g"]).trim();
	ctx.npmRoot.root = root;
	ctx.npmRoot.key = commandKey;
	return root;
}

export function getPnpmGlobalPackagePath(
	ctx: PackageContext,
	packageName: string,
): string | undefined {
	if (getPackageManagerName(ctx) !== "pnpm") {
		return undefined;
	}

	const output = runNpmCommandSync(ctx, ["list", "-g", "--depth", "0", "--json"]);
	const entries = JSON.parse(output) as Array<{
		dependencies?: Record<string, { path?: string }>;
	}>;
	for (const entry of entries) {
		const path = entry.dependencies?.[packageName]?.path;
		if (path) return path;
	}
	return undefined;
}

export function getLegacyGlobalNpmPath(ctx: PackageContext, source: NpmSource): string | undefined {
	try {
		return getPnpmGlobalPackagePath(ctx, source.name) ?? join(getGlobalNpmRoot(ctx), source.name);
	} catch {
		return undefined;
	}
}

export function getNpmPath(ctx: PackageContext, source: NpmSource, scope: SourceScope): string {
	const managedPath = getManagedNpmPath(ctx, source, scope);
	if (scope !== "user" || existsSync(managedPath)) {
		return managedPath;
	}
	const legacyPath = getLegacyGlobalNpmPath(ctx, source);
	return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
}

export async function getLatestNpmVersion(
	ctx: PackageContext,
	packageSpec: string,
	range?: string,
): Promise<string> {
	const npmCommand = getNpmCommand(ctx);
	const stdout = await ctx.runCommandCapture(
		npmCommand.command,
		[...npmCommand.args, "view", packageSpec, "version", "--json"],
		{ cwd: ctx.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
	);
	const raw = stdout.trim();
	if (!raw) throw new Error("Empty npm response");
	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed === "string") {
		return parsed;
	}
	if (Array.isArray(parsed)) {
		const versions = parsed.filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		const latest = range ? maxSatisfying(versions, range) : [...versions].sort(rcompare)[0];
		if (latest) return latest;
	}
	throw new Error("Invalid npm response");
}

export async function npmHasAvailableUpdate(
	ctx: PackageContext,
	source: NpmSource,
	installedPath: string,
): Promise<boolean> {
	if (isOfflineModeEnabled()) {
		return false;
	}

	const installedVersion = getInstalledNpmVersion(installedPath);
	if (!installedVersion) {
		return false;
	}

	try {
		const targetVersion = await getLatestNpmVersion(
			ctx,
			source.version ? source.spec : source.name,
			source.range,
		);
		return gt(targetVersion, installedVersion);
	} catch {
		return false;
	}
}

export async function shouldUpdateNpmSource(
	ctx: PackageContext,
	source: NpmSource,
	scope: InstalledSourceScope,
): Promise<boolean> {
	const installedPath = getManagedNpmPath(ctx, source, scope);
	const installedVersion = existsSync(installedPath)
		? getInstalledNpmVersion(installedPath)
		: undefined;
	if (!installedVersion) {
		return true;
	}

	try {
		const targetVersion = await getLatestNpmVersion(
			ctx,
			source.version ? source.spec : source.name,
			source.range,
		);
		return gt(targetVersion, installedVersion);
	} catch {
		return true;
	}
}
