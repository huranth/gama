import { existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { isLocalPath } from "../../utils/paths.ts";
import {
	applyAutoloadDisabledPatterns,
	getNpmVersionRange,
	getOverridePatterns,
	isEnabledByOverrides,
	isExactNpmVersion,
	isOfflineModeEnabled,
	RESOURCE_TYPES,
} from "../resource-scan.ts";
import type { PackageSource } from "../settings.ts";
import { BUILTIN_PATH_PREFIX } from "../origin.ts";
import {
	addAutoDiscoveredResources,
	addResource,
	collectPackageResources,
	createAccumulator,
	getTargetMap,
	resolveLocalEntries,
	toResolvedPaths,
} from "./walk.ts";
import { installGit, refreshTemporaryGitSource } from "./git.ts";
import { getNpmPath, installNpm, installedNpmMatchesRange } from "./npm.ts";
import { baseDirForScope, getGitInstallPath, resolveFromBase, resolveUserPath } from "./dirs.ts";
import type {
	ConfiguredPackage,
	LocalSource,
	MissingSourceAction,
	PackageContext,
	PackageFilter,
	ParsedSource,
	PathMetadata,
	ResolvedPaths,
	ResourceAccumulator,
	SourceScope,
} from "./types.ts";

export function parseNpmSpec(spec: string): { name: string; version?: string } {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	if (!match) {
		return { name: spec };
	}
	const name = match[1] ?? spec;
	const version = match[2];
	return { name, version };
}

export function parseSource(source: string): ParsedSource {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length).trim();
		const { name, version } = parseNpmSpec(spec);
		return {
			type: "npm",
			spec,
			name,
			version,
			range: getNpmVersionRange(version),
			pinned: isExactNpmVersion(version),
		};
	}

	if (isLocalPath(source)) {
		return { type: "local", path: source };
	}

	const gitParsed = parseGitUrl(source);
	if (gitParsed) {
		return gitParsed;
	}

	return { type: "local", path: source };
}

export function getPackageSourceString(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

export function getSourceMatchKeyForInput(ctx: PackageContext, source: string): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	return `local:${resolveUserPath(ctx, parsed.path)}`;
}

export function getSourceMatchKeyForSettings(
	ctx: PackageContext,
	source: string,
	scope: SourceScope,
): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	const baseDir = baseDirForScope(ctx, scope);
	return `local:${resolveFromBase(parsed.path, baseDir)}`;
}

export function getPackageIdentity(
	ctx: PackageContext,
	source: string,
	scope?: SourceScope,
): string {
	if (scope) {
		return getSourceMatchKeyForSettings(ctx, source, scope);
	}
	return getSourceMatchKeyForInput(ctx, source);
}

export function packageSourcesMatch(
	ctx: PackageContext,
	existing: PackageSource,
	inputSource: string,
	scope: SourceScope,
): boolean {
	const left = getSourceMatchKeyForSettings(ctx, getPackageSourceString(existing), scope);
	const right = getSourceMatchKeyForInput(ctx, inputSource);

	return left === right;
}

export function normalizePackageSourceForSettings(
	ctx: PackageContext,
	source: string,
	scope: SourceScope,
): string {
	const parsed = parseSource(source);
	if (parsed.type !== "local") {
		return source;
	}
	const baseDir = baseDirForScope(ctx, scope);
	const resolved = resolveUserPath(ctx, parsed.path);
	const rel = relative(baseDir, resolved);
	return rel || ".";
}

export function dedupePackages(
	ctx: PackageContext,
	packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
): Array<{ pkg: PackageSource; scope: SourceScope }> {
	const result: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
	const seen = new Map<string, number>();
	for (const entry of packages) {
		const identity = getPackageIdentity(ctx, getPackageSourceString(entry.pkg), entry.scope);
		const index = seen.get(identity);
		if (index === undefined) {
			seen.set(identity, result.length);
			result.push(entry);
			continue;
		}
		const existing = result[index];
		if (existing?.scope === "project" && entry.scope === "user") {
			if (typeof existing.pkg === "object" && existing.pkg.autoload === false) result.push(entry);
		} else if (entry.scope === "project") {
			result[index] = entry;
		}
	}
	return result;
}

export function addSourceToSettings(
	ctx: PackageContext,
	source: string,
	options?: { local?: boolean },
): boolean {
	const scope: SourceScope = options?.local ? "project" : "user";
	const currentSettings =
		scope === "project" ? ctx.settings.getProjectSettings() : ctx.settings.getGlobalSettings();
	const currentPackages = currentSettings.packages ?? [];
	const normalizedSource = normalizePackageSourceForSettings(ctx, source, scope);
	const matchIndex = currentPackages.findIndex((existing) =>
		packageSourcesMatch(ctx, existing, source, scope),
	);
	if (matchIndex !== -1) {
		const existing = currentPackages[matchIndex];
		if (getPackageSourceString(existing) === normalizedSource) {
			return false;
		}
		const nextPackages = [...currentPackages];
		nextPackages[matchIndex] =
			typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
		if (scope === "project") {
			ctx.settings.setProjectPackages(nextPackages);
		} else {
			ctx.settings.setPackages(nextPackages);
		}
		return true;
	}
	const nextPackages = [...currentPackages, normalizedSource];
	if (scope === "project") {
		ctx.settings.setProjectPackages(nextPackages);
	} else {
		ctx.settings.setPackages(nextPackages);
	}
	return true;
}

export function removeSourceFromSettings(
	ctx: PackageContext,
	source: string,
	options?: { local?: boolean },
): boolean {
	const scope: SourceScope = options?.local ? "project" : "user";
	const currentSettings =
		scope === "project" ? ctx.settings.getProjectSettings() : ctx.settings.getGlobalSettings();
	const currentPackages = currentSettings.packages ?? [];
	const nextPackages = currentPackages.filter(
		(existing) => !packageSourcesMatch(ctx, existing, source, scope),
	);
	const changed = nextPackages.length !== currentPackages.length;
	if (!changed) {
		return false;
	}
	if (scope === "project") {
		ctx.settings.setProjectPackages(nextPackages);
	} else {
		ctx.settings.setPackages(nextPackages);
	}
	return true;
}

export function listConfiguredPackages(ctx: PackageContext): ConfiguredPackage[] {
	const globalSettings = ctx.settings.getGlobalSettings();
	const projectSettings = ctx.settings.getProjectSettings();
	const configuredPackages: ConfiguredPackage[] = [];

	for (const pkg of globalSettings.packages ?? []) {
		const source = getPackageSourceString(pkg);
		configuredPackages.push({
			source,
			scope: "user",
			filtered: typeof pkg === "object",
			installedPath: getInstalledPath(ctx, source, "user"),
		});
	}

	for (const pkg of projectSettings.packages ?? []) {
		const source = getPackageSourceString(pkg);
		configuredPackages.push({
			source,
			scope: "project",
			filtered: typeof pkg === "object",
			installedPath: getInstalledPath(ctx, source, "project"),
		});
	}

	return configuredPackages;
}

export function getInstalledPath(
	ctx: PackageContext,
	source: string,
	scope: "user" | "project",
): string | undefined {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		const path = getNpmPath(ctx, parsed, scope);
		return existsSync(path) ? path : undefined;
	}
	if (parsed.type === "git") {
		const path = getGitInstallPath(ctx, parsed, scope);
		return existsSync(path) ? path : undefined;
	}
	if (parsed.type === "local") {
		const baseDir = baseDirForScope(ctx, scope);
		const path = resolveFromBase(parsed.path, baseDir);
		return existsSync(path) ? path : undefined;
	}
	return undefined;
}

export function buildNoMatchingPackageMessage(
	source: string,
	configuredPackages: PackageSource[],
): string {
	const suggestion = findSuggestedConfiguredSource(source, configuredPackages);
	if (!suggestion) {
		return `No matching package found for ${source}`;
	}
	return `No matching package found for ${source}. Did you mean ${suggestion}?`;
}

function findSuggestedConfiguredSource(
	source: string,
	configuredPackages: PackageSource[],
): string | undefined {
	const trimmedSource = source.trim();
	const suggestions = new Set<string>();

	for (const pkg of configuredPackages) {
		const sourceStr = getPackageSourceString(pkg);
		const parsed = parseSource(sourceStr);
		if (parsed.type === "npm") {
			if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
				suggestions.add(sourceStr);
			}
			continue;
		}
		if (parsed.type === "git") {
			const shorthand = `${parsed.host}/${parsed.path}`;
			const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
			if (
				trimmedSource === shorthand ||
				(shorthandWithRef && trimmedSource === shorthandWithRef)
			) {
				suggestions.add(sourceStr);
			}
		}
	}

	return suggestions.values().next().value;
}

export async function resolvePaths(
	ctx: PackageContext,
	onMissing?: (source: string) => Promise<MissingSourceAction>,
): Promise<ResolvedPaths> {
	const accumulator = createAccumulator();
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
	await resolvePackageSources(ctx, packageSources, accumulator, onMissing);

	const globalBaseDir = ctx.agentDir;
	const projectBaseDir = join(ctx.cwd, CONFIG_DIR_NAME);

	for (const resourceType of RESOURCE_TYPES) {
		const target = getTargetMap(accumulator, resourceType);
		const globalEntries = (globalSettings[resourceType] ?? []) as string[];
		const projectEntries = (projectSettings[resourceType] ?? []) as string[];
		resolveLocalEntries(
			projectEntries,
			resourceType,
			target,
			{
				source: "local",
				scope: "project",
				origin: "top-level",
			},
			projectBaseDir,
		);
		resolveLocalEntries(
			globalEntries,
			resourceType,
			target,
			{
				source: "local",
				scope: "user",
				origin: "top-level",
			},
			globalBaseDir,
		);
	}

	addAutoDiscoveredResources(
		ctx,
		accumulator,
		globalSettings,
		projectSettings,
		globalBaseDir,
		projectBaseDir,
	);

	for (const name of ctx.builtinExtensions) {
		const path = `${BUILTIN_PATH_PREFIX}${name}`;
		const projectEnabled = applyAutoloadDisabledPatterns(
			[path],
			getOverridePatterns(projectSettings.extensions ?? []),
			projectBaseDir,
		).get(path);
		addResource(
			accumulator.extensions,
			path,
			{
				source: "builtin",
				scope: projectEnabled === undefined ? "user" : "project",
				origin: "top-level",
			},
			projectEnabled ?? isEnabledByOverrides(path, globalSettings.extensions ?? [], globalBaseDir),
		);
	}

	return toResolvedPaths(accumulator);
}

export async function resolveExtensionSources(
	ctx: PackageContext,
	sources: string[],
	options?: { local?: boolean; temporary?: boolean },
): Promise<ResolvedPaths> {
	const accumulator = createAccumulator();
	let scope: SourceScope = "user";
	if (options?.temporary) scope = "temporary";
	else if (options?.local) scope = "project";

	const builtinSources = sources.filter((source) => source.startsWith(BUILTIN_PATH_PREFIX));
	for (const source of builtinSources) {
		addResource(
			accumulator.extensions,
			source,
			{ source: "builtin", scope, origin: "top-level" },
			true,
		);
	}
	const packageSources = sources
		.filter((source) => !source.startsWith(BUILTIN_PATH_PREFIX))
		.map((source) => ({ pkg: source as PackageSource, scope }));
	await resolvePackageSources(ctx, packageSources, accumulator);
	return toResolvedPaths(accumulator);
}

export async function resolvePackageSources(
	ctx: PackageContext,
	sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	accumulator: ResourceAccumulator,
	onMissing?: (source: string) => Promise<MissingSourceAction>,
): Promise<void> {
	for (const { pkg, scope } of sources) {
		const sourceStr = getPackageSourceString(pkg);
		const filter = typeof pkg === "object" ? pkg : undefined;
		const deltaBase = findAutoloadDeltaBase(ctx, pkg, scope, sources);
		const resolvedSource = deltaBase?.source ?? sourceStr;
		const resolvedScope = deltaBase?.scope ?? scope;
		const parsed = parseSource(resolvedSource);
		const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

		if (parsed.type === "local") {
			const baseDir = baseDirForScope(ctx, resolvedScope);
			resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
			continue;
		}

		const installMissing = async (): Promise<boolean> => {
			if (isOfflineModeEnabled()) return false;
			if (!onMissing) {
				await installParsedSource(ctx, parsed, resolvedScope);
				return true;
			}
			const action = await onMissing(resolvedSource);
			if (action === "skip") return false;
			if (action === "error") throw new Error(`Missing source: ${resolvedSource}`);
			await installParsedSource(ctx, parsed, resolvedScope);
			return true;
		};

		if (parsed.type === "npm") {
			let installedPath = getNpmPath(ctx, parsed, resolvedScope);
			const needsInstall =
				!existsSync(installedPath) ||
				!(await installedNpmMatchesRange(parsed, installedPath));
			if (needsInstall) {
				const installed = await installMissing();
				if (!installed) continue;
				installedPath = getNpmPath(ctx, parsed, resolvedScope);
			}
			metadata.baseDir = installedPath;
			metadata.packageRoot = installedPath;
			collectPackageResources(installedPath, accumulator, filter, metadata);
			continue;
		}

		if (parsed.type === "git") {
			const installedPath = getGitInstallPath(ctx, parsed, resolvedScope);
			if (!existsSync(installedPath)) {
				const installed = await installMissing();
				if (!installed) continue;
			} else if (resolvedScope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
				await refreshTemporaryGitSource(ctx, parsed, resolvedSource);
			}
			metadata.baseDir = installedPath;
			metadata.packageRoot = installedPath;
			collectPackageResources(installedPath, accumulator, filter, metadata);
		}
	}
}

function findAutoloadDeltaBase(
	ctx: PackageContext,
	pkg: PackageSource,
	scope: SourceScope,
	sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
): { source: string; scope: SourceScope } | undefined {
	if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
	const identity = getPackageIdentity(ctx, pkg.source, scope);
	const userEntry = sources.find(
		(entry) =>
			entry.scope === "user" &&
			getPackageIdentity(ctx, getPackageSourceString(entry.pkg), "user") === identity,
	);
	return userEntry ? { source: getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
}

function resolveLocalExtensionSource(
	source: LocalSource,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
	baseDir: string,
): void {
	const resolved = resolveFromBase(source.path, baseDir);
	if (!existsSync(resolved)) {
		return;
	}

	try {
		const stats = statSync(resolved);
		if (stats.isFile()) {
			metadata.baseDir = dirname(resolved);
			addResource(accumulator.extensions, resolved, metadata, true);
			return;
		}
		if (stats.isDirectory()) {
			metadata.baseDir = resolved;
			metadata.packageRoot = resolved;
			const resources = collectPackageResources(resolved, accumulator, filter, metadata);
			if (!resources) {
				addResource(accumulator.extensions, resolved, metadata, true);
			}
		}
	} catch {
		return;
	}
}

async function installParsedSource(
	ctx: PackageContext,
	parsed: ParsedSource,
	scope: SourceScope,
): Promise<void> {
	if (parsed.type === "npm") {
		await installNpm(ctx, parsed, scope, scope === "temporary");
		return;
	}
	if (parsed.type === "git") {
		await installGit(ctx, parsed, scope);
		return;
	}
}

