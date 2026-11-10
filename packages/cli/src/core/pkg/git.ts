import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { GitSource } from "../../utils/git.ts";
import { stripBom } from "../../utils/text.ts";
import { isOfflineModeEnabled, NETWORK_TIMEOUT_MS } from "../resource-scan.ts";
import {
	ensureGitIgnore,
	getGitInstallPath,
	getGitRoot,
	gitUpdateMarkerPath,
	pruneEmptyGitParents,
} from "./dirs.ts";
import { getGitDependencyInstallArgs, runNpmCommand } from "./npm.ts";
import type { PackageContext, SourceScope } from "./types.ts";

export function runGitRemoteCommand(
	ctx: PackageContext,
	installedPath: string,
	args: string[],
): Promise<string> {
	return ctx.runCommandCapture("git", args, {
		cwd: installedPath,
		timeoutMs: NETWORK_TIMEOUT_MS,
		env: {
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

export async function getGitUpstreamRef(
	ctx: PackageContext,
	installedPath: string,
): Promise<string | undefined> {
	try {
		const upstream = await ctx.runCommandCapture(
			"git",
			["rev-parse", "--abbrev-ref", "@{upstream}"],
			{
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			},
		);
		const trimmed = upstream.trim();
		if (!trimmed.startsWith("origin/")) {
			return undefined;
		}
		const branch = trimmed.slice("origin/".length);
		return branch ? `refs/heads/${branch}` : undefined;
	} catch {
		return undefined;
	}
}

export async function getRemoteGitHead(
	ctx: PackageContext,
	installedPath: string,
): Promise<string> {
	const upstreamRef = await getGitUpstreamRef(ctx, installedPath);
	if (upstreamRef) {
		const remoteHead = await runGitRemoteCommand(ctx, installedPath, [
			"ls-remote",
			"origin",
			upstreamRef,
		]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
		if (match?.[1]) {
			return match[1];
		}
	}

	const remoteHead = await runGitRemoteCommand(ctx, installedPath, [
		"ls-remote",
		"origin",
		"HEAD",
	]);
	const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
	if (!match?.[1]) {
		throw new Error("Missing remote HEAD");
	}
	return match[1];
}

export async function getLocalGitUpdateTarget(
	ctx: PackageContext,
	installedPath: string,
): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
	try {
		const upstream = await ctx.runCommandCapture(
			"git",
			["rev-parse", "--abbrev-ref", "@{upstream}"],
			{
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			},
		);
		const trimmedUpstream = upstream.trim();
		if (!trimmedUpstream.startsWith("origin/")) {
			throw new Error(`Unsupported remote: ${trimmedUpstream}`);
		}
		const branch = trimmedUpstream.slice("origin/".length);
		if (!branch) {
			throw new Error("Missing upstream branch");
		}
		const head = await ctx.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return {
			ref: "@{upstream}",
			head,
			fetchArgs: [
				"fetch",
				"--prune",
				"--no-tags",
				"origin",
				`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
			],
		};
	} catch {
		await ctx
			.runCommand("git", ["remote", "set-head", "origin", "-a"], {
				cwd: installedPath,
			})
			.catch(() => {});
		const head = await ctx.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const originHeadRef = await ctx
			.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			})
			.catch(() => "");
		const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
		if (branch) {
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		}
		return {
			ref: "origin/HEAD",
			head,
			fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
		};
	}
}

export async function gitHasAvailableUpdate(
	ctx: PackageContext,
	installedPath: string,
): Promise<boolean> {
	if (isOfflineModeEnabled()) {
		return false;
	}

	try {
		const localHead = await ctx.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const remoteHead = await getRemoteGitHead(ctx, installedPath);
		return localHead.trim() !== remoteHead.trim();
	} catch {
		return false;
	}
}

export function hasMissingGitDependencies(targetDir: string): boolean {
	const packageJsonPath = join(targetDir, "package.json");
	if (!existsSync(packageJsonPath)) return false;

	try {
		const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as {
			dependencies?: unknown;
		};
		if (
			!manifest.dependencies ||
			typeof manifest.dependencies !== "object" ||
			Array.isArray(manifest.dependencies)
		) {
			return false;
		}

		const nodeModulesDir = resolve(targetDir, "node_modules");
		return Object.keys(manifest.dependencies).some((name) => {
			const dependencyPath = resolve(nodeModulesDir, name);
			if (!dependencyPath.startsWith(`${nodeModulesDir}${sep}`)) return false;
			return !existsSync(dependencyPath);
		});
	} catch {
		return false;
	}
}

export async function repairMissingGitDependencies(
	ctx: PackageContext,
	targetDir: string,
): Promise<void> {
	if (!hasMissingGitDependencies(targetDir)) return;
	await runNpmCommand(ctx, getGitDependencyInstallArgs(ctx), { cwd: targetDir });
}

export async function cleanAndInstallGitDependencies(
	ctx: PackageContext,
	targetDir: string,
	markerPath: string,
): Promise<void> {
	try {
		await ctx.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });
	} catch (error) {
		await repairMissingGitDependencies(ctx, targetDir).catch(() => {});
		throw error;
	}

	const packageJsonPath = join(targetDir, "package.json");
	if (existsSync(packageJsonPath)) {
		await runNpmCommand(ctx, getGitDependencyInstallArgs(ctx), { cwd: targetDir });
	}
	rmSync(markerPath, { force: true });
}

export async function ensureGitRef(
	ctx: PackageContext,
	targetDir: string,
	fetchArgs: string[],
	ref: string,
): Promise<void> {
	await ctx.runCommand("git", fetchArgs, { cwd: targetDir });

	const localHead = await ctx.runCommandCapture("git", ["rev-parse", "HEAD"], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	const commitRef = `${ref}^{commit}`;
	const targetHead = await ctx.runCommandCapture("git", ["rev-parse", commitRef], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	const markerPath = gitUpdateMarkerPath(targetDir);
	if (localHead.trim() === targetHead.trim()) {
		if (existsSync(markerPath)) {
			await cleanAndInstallGitDependencies(ctx, targetDir, markerPath);
		} else {
			await repairMissingGitDependencies(ctx, targetDir);
		}
		return;
	}

	writeFileSync(markerPath, "", "utf-8");
	await ctx.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });
	await cleanAndInstallGitDependencies(ctx, targetDir, markerPath);
}

export async function installGit(
	ctx: PackageContext,
	source: GitSource,
	scope: SourceScope,
): Promise<void> {
	const targetDir = getGitInstallPath(ctx, source, scope);
	if (existsSync(targetDir)) {
		if (source.ref) {
			await ensureGitRef(ctx, targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}
		const target = await getLocalGitUpdateTarget(ctx, targetDir);
		await ensureGitRef(ctx, targetDir, target.fetchArgs, target.ref);
		return;
	}
	const gitRoot = getGitRoot(ctx, scope);
	if (gitRoot) {
		ensureGitIgnore(gitRoot);
	}
	mkdirSync(dirname(targetDir), { recursive: true });
	rmSync(gitUpdateMarkerPath(targetDir), { force: true });

	try {
		await ctx.runCommand("git", ["clone", source.repo, targetDir]);
		if (source.ref) {
			await ctx.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await runNpmCommand(ctx, getGitDependencyInstallArgs(ctx), { cwd: targetDir });
		}
	} catch (error) {
		rmSync(targetDir, { recursive: true, force: true });
		pruneEmptyGitParents(targetDir, gitRoot);
		throw error;
	}
}

export async function updateGit(
	ctx: PackageContext,
	source: GitSource,
	scope: SourceScope,
): Promise<void> {
	const targetDir = getGitInstallPath(ctx, source, scope);
	if (!existsSync(targetDir)) {
		await installGit(ctx, source, scope);
		return;
	}

	if (source.ref) {
		await ensureGitRef(ctx, targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
		return;
	}

	const target = await getLocalGitUpdateTarget(ctx, targetDir);
	await ensureGitRef(ctx, targetDir, target.fetchArgs, target.ref);
}

export async function removeGit(
	ctx: PackageContext,
	source: GitSource,
	scope: SourceScope,
): Promise<void> {
	const targetDir = getGitInstallPath(ctx, source, scope);
	rmSync(targetDir, { recursive: true, force: true });
	rmSync(gitUpdateMarkerPath(targetDir), { force: true });
	pruneEmptyGitParents(targetDir, getGitRoot(ctx, scope));
}

export async function refreshTemporaryGitSource(
	ctx: PackageContext,
	source: GitSource,
	sourceStr: string,
): Promise<void> {
	if (isOfflineModeEnabled()) {
		return;
	}
	try {
		await ctx.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
			await updateGit(ctx, source, "temporary");
		});
	} catch {}
}
