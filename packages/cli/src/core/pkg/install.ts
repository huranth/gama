import { existsSync } from "node:fs";
import {
	GIT_UPDATE_CONCURRENCY,
	isOfflineModeEnabled,
	UPDATE_CHECK_CONCURRENCY,
} from "../resource-scan.ts";
import type { PackageSource } from "../settings.ts";
import { assertTrusted, getGitInstallPath, resolveUserPath } from "./dirs.ts";
import { gitHasAvailableUpdate, installGit, removeGit, updateGit } from "./git.ts";
import {
	getNpmPath,
	installNpm,
	installNpmBatch,
	npmHasAvailableUpdate,
	shouldUpdateNpmSource,
	uninstallNpm,
} from "./npm.ts";
import {
	addSourceToSettings,
	buildNoMatchingPackageMessage,
	dedupePackages,
	getPackageIdentity,
	getPackageSourceString,
	parseSource,
	removeSourceFromSettings,
} from "./source.ts";
import type {
	ConfiguredUpdateSource,
	GitUpdateTarget,
	InstalledSourceScope,
	NpmUpdateTarget,
	PackageContext,
	PackageUpdate,
	SourceScope,
} from "./types.ts";

export async function runWithConcurrency<T>(
	tasks: Array<() => Promise<T>>,
	limit: number,
): Promise<T[]> {
	if (tasks.length === 0) {
		return [];
	}

	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, tasks.length));

	const worker = async () => {
		while (true) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= tasks.length) {
				return;
			}
			results[index] = await tasks[index]();
		}
	};

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

export async function install(
	ctx: PackageContext,
	source: string,
	options?: { local?: boolean },
): Promise<void> {
	const parsed = parseSource(source);
	const scope: SourceScope = options?.local ? "project" : "user";
	assertTrusted(ctx, scope);
	await ctx.withProgress("install", source, `Installing ${source}...`, async () => {
		if (parsed.type === "npm") {
			await installNpm(ctx, parsed, scope, false);
			return;
		}
		if (parsed.type === "git") {
			await installGit(ctx, parsed, scope);
			return;
		}
		if (parsed.type === "local") {
			const resolved = resolveUserPath(ctx, parsed.path);
			if (!existsSync(resolved)) {
				throw new Error(`Missing path: ${resolved}`);
			}
			return;
		}
		throw new Error(`Unsupported source: ${source}`);
	});
}

export async function installAndPersist(
	ctx: PackageContext,
	source: string,
	options?: { local?: boolean },
): Promise<void> {
	await install(ctx, source, options);
	addSourceToSettings(ctx, source, options);
}

export async function remove(
	ctx: PackageContext,
	source: string,
	options?: { local?: boolean },
): Promise<void> {
	const parsed = parseSource(source);
	const scope: SourceScope = options?.local ? "project" : "user";
	assertTrusted(ctx, scope);
	await ctx.withProgress("remove", source, `Removing ${source}...`, async () => {
		if (parsed.type === "npm") {
			await uninstallNpm(ctx, parsed, scope);
			return;
		}
		if (parsed.type === "git") {
			await removeGit(ctx, parsed, scope);
			return;
		}
		if (parsed.type === "local") {
			return;
		}
		throw new Error(`Unsupported source: ${source}`);
	});
}

export async function removeAndPersist(
	ctx: PackageContext,
	source: string,
	options?: { local?: boolean },
): Promise<boolean> {
	await remove(ctx, source, options);
	return removeSourceFromSettings(ctx, source, options);
}

export async function update(ctx: PackageContext, source?: string): Promise<void> {
	const globalSettings = ctx.settings.getGlobalSettings();
	const projectSettings = ctx.settings.getProjectSettings();
	const identity = source ? getPackageIdentity(ctx, source) : undefined;
	let matched = false;
	const updateSources: ConfiguredUpdateSource[] = [];

	for (const pkg of globalSettings.packages ?? []) {
		const sourceStr = getPackageSourceString(pkg);
		if (identity && getPackageIdentity(ctx, sourceStr, "user") !== identity) continue;
		matched = true;
		updateSources.push({ source: sourceStr, scope: "user" });
	}
	for (const pkg of projectSettings.packages ?? []) {
		const sourceStr = getPackageSourceString(pkg);
		if (identity && getPackageIdentity(ctx, sourceStr, "project") !== identity) continue;
		matched = true;
		updateSources.push({ source: sourceStr, scope: "project" });
	}

	if (source && !matched) {
		throw new Error(
			buildNoMatchingPackageMessage(source, [
				...(globalSettings.packages ?? []),
				...(projectSettings.packages ?? []),
			]),
		);
	}

	await updateConfiguredSources(ctx, updateSources);
}

async function updateConfiguredSources(
	ctx: PackageContext,
	sources: ConfiguredUpdateSource[],
): Promise<void> {
	if (isOfflineModeEnabled() || sources.length === 0) {
		return;
	}

	const npmCandidates: NpmUpdateTarget[] = [];
	const gitCandidates: GitUpdateTarget[] = [];

	for (const entry of sources) {
		const parsed = parseSource(entry.source);
		if (parsed.type === "npm") {
			if (!parsed.pinned) {
				npmCandidates.push({ ...entry, parsed });
			}
		} else if (parsed.type === "git") {
			gitCandidates.push({ ...entry, parsed });
		}
	}

	const npmCheckTasks = npmCandidates.map((entry) => async () => ({
		entry,
		shouldUpdate: await shouldUpdateNpmSource(ctx, entry.parsed, entry.scope),
	}));
	const npmCheckResults = await runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
	const userNpmUpdates: NpmUpdateTarget[] = [];
	const projectNpmUpdates: NpmUpdateTarget[] = [];
	for (const result of npmCheckResults) {
		if (!result.shouldUpdate) {
			continue;
		}
		if (result.entry.scope === "user") {
			userNpmUpdates.push(result.entry);
		} else {
			projectNpmUpdates.push(result.entry);
		}
	}

	const tasks: Promise<void>[] = [];
	if (userNpmUpdates.length > 0) {
		tasks.push(updateNpmBatch(ctx, userNpmUpdates, "user"));
	}
	if (projectNpmUpdates.length > 0) {
		tasks.push(updateNpmBatch(ctx, projectNpmUpdates, "project"));
	}
	if (gitCandidates.length > 0) {
		const gitTasks = gitCandidates.map(
			(entry) => async () =>
				ctx.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
					await updateGit(ctx, entry.parsed, entry.scope);
				}),
		);
		tasks.push(runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
	}

	await Promise.all(tasks);
}

async function updateNpmBatch(
	ctx: PackageContext,
	sources: NpmUpdateTarget[],
	scope: InstalledSourceScope,
): Promise<void> {
	if (sources.length === 0) {
		return;
	}

	const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
	const message =
		sources.length === 1
			? `Updating ${sources[0].source}...`
			: `Updating ${scope} npm packages...`;
	const specs = sources.map((entry) =>
		entry.parsed.version ? entry.parsed.spec : `${entry.parsed.name}@latest`,
	);

	await ctx.withProgress("update", sourceLabel, message, async () => {
		await installNpmBatch(ctx, specs, scope);
	});
}

export async function checkForAvailableUpdates(ctx: PackageContext): Promise<PackageUpdate[]> {
	if (isOfflineModeEnabled()) {
		return [];
	}

	const globalSettings = ctx.settings.getGlobalSettings();
	const projectSettings = ctx.settings.getProjectSettings();
	const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
	for (const pkg of projectSettings.packages ?? []) {
		allPackages.push({ pkg, scope: "project" });
	}
	for (const pkg of globalSettings.packages ?? []) {
		allPackages.push({ pkg, scope: "user" });
	}

	const packageSources = dedupePackages(ctx, allPackages);
	const checks = packageSources
		.filter(
			(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } =>
				entry.scope !== "temporary",
		)
		.map((entry) => async (): Promise<PackageUpdate | undefined> => {
			const source = getPackageSourceString(entry.pkg);
			const parsed = parseSource(source);
			if (parsed.type === "local" || parsed.pinned) {
				return undefined;
			}

			if (parsed.type === "npm") {
				const installedPath = getNpmPath(ctx, parsed, entry.scope);
				if (!existsSync(installedPath)) {
					return undefined;
				}
				const hasUpdate = await npmHasAvailableUpdate(ctx, parsed, installedPath);
				if (!hasUpdate) {
					return undefined;
				}
				return {
					source,
					displayName: parsed.name,
					type: "npm",
					scope: entry.scope,
				};
			}

			const installedPath = getGitInstallPath(ctx, parsed, entry.scope);
			if (!existsSync(installedPath)) {
				return undefined;
			}
			const hasUpdate = await gitHasAvailableUpdate(ctx, installedPath);
			if (!hasUpdate) {
				return undefined;
			}
			return {
				source,
				displayName: `${parsed.host}/${parsed.path}`,
				type: "git",
				scope: entry.scope,
			};
		});

	const results = await runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
	return results.filter((result): result is PackageUpdate => result !== undefined);
}
