import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { GitSource } from "../../utils/git.ts";
import { resolvePath } from "../../utils/paths.ts";
import { getExtensionTempFolder, getHomeDir } from "../resource-scan.ts";
import type { NpmSource, PackageContext, SourceScope } from "./types.ts";

export function resolveUserPath(ctx: PackageContext, input: string): string {
	return resolvePath(input, ctx.cwd, { homeDir: getHomeDir(), trim: true });
}

export function resolveFromBase(input: string, baseDir: string): string {
	return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
}

export function assertTrusted(ctx: PackageContext, scope: SourceScope): void {
	if (scope === "project" && !ctx.settings.isProjectTrusted()) {
		throw new Error("Project not trusted");
	}
}

export function baseDirForScope(ctx: PackageContext, scope: SourceScope): string {
	if (scope === "project") {
		assertTrusted(ctx, scope);
		return join(ctx.cwd, CONFIG_DIR_NAME);
	}
	if (scope === "user") {
		return ctx.agentDir;
	}
	return ctx.cwd;
}

export function resolveInsideRoot(root: string, ...parts: string[]): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, ...parts);
	if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
		throw new Error(`Path outside root: ${resolvedPath}`);
	}
	return resolvedPath;
}

export function getTempDir(
	ctx: PackageContext,
	prefix: string,
	suffix?: string,
	ref?: string,
): string {
	const root = resolveInsideRoot(getExtensionTempFolder(ctx.agentDir), prefix);
	const hash = createHash("sha256")
		.update(`${prefix}-${suffix ?? ""}${ref ? `@${ref}` : ""}`)
		.digest("hex")
		.slice(0, 8);
	return resolveInsideRoot(root, hash, suffix ?? "");
}

export function getNpmRoot(ctx: PackageContext, scope: SourceScope, temporary: boolean): string {
	if (temporary) {
		return getTempDir(ctx, "npm");
	}
	if (scope === "project") {
		assertTrusted(ctx, scope);
		return join(ctx.cwd, CONFIG_DIR_NAME, "npm");
	}
	return join(ctx.agentDir, "npm");
}

export function getGitRoot(ctx: PackageContext, scope: SourceScope): string | undefined {
	if (scope === "temporary") {
		return undefined;
	}
	if (scope === "project") {
		assertTrusted(ctx, scope);
		return join(ctx.cwd, CONFIG_DIR_NAME, "git");
	}
	return join(ctx.agentDir, "git");
}

export function getManagedNpmPath(
	ctx: PackageContext,
	source: NpmSource,
	scope: SourceScope,
): string {
	const installRoot = getNpmRoot(ctx, scope, scope === "temporary");
	return join(installRoot, "node_modules", source.name);
}

export function getGitInstallPath(
	ctx: PackageContext,
	source: GitSource,
	scope: SourceScope,
): string {
	if (scope === "temporary") {
		return getTempDir(ctx, `git-${source.host}`, source.path, source.ref);
	}
	const installRoot = getGitRoot(ctx, scope);
	if (!installRoot) {
		throw new Error("Missing install root");
	}
	return resolveInsideRoot(installRoot, source.host, source.path);
}

export function gitUpdateMarkerPath(targetDir: string): string {
	return join(dirname(targetDir), `.${basename(targetDir)}.gama-update-incomplete`);
}

export function ensureGitIgnore(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const ignorePath = join(dir, ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
	}
}

export function pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
	if (!installRoot) return;
	const resolvedRoot = resolve(installRoot);
	let current = dirname(targetDir);
	while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
		if (!existsSync(current)) {
			current = dirname(current);
			continue;
		}
		const entries = readdirSync(current);
		if (entries.length > 0) {
			break;
		}
		try {
			rmSync(current, { recursive: true, force: true });
		} catch {
			break;
		}
		current = dirname(current);
	}
}
