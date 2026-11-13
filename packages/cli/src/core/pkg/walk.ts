import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalizePath } from "../../utils/paths.ts";
import { type GamaManifest, readGamaManifest } from "../gama-manifest.ts";
import {
	applyAutoloadDisabledPatterns,
	applyPatterns,
	collectAncestorAgentsSkillDirs,
	collectAutoExtensionEntries,
	collectAutoPromptEntries,
	collectAutoSkillEntries,
	collectAutoThemeEntries,
	collectResourceFiles,
	expandPackageGlob,
	getHomeDir,
	hasGlobPattern,
	isEnabledByOverrides,
	isOverridePattern,
	RESOURCE_TYPES,
	type ResourceType,
	resourcePrecedenceRank,
	splitPatterns,
} from "../resource-scan.ts";
import type { SettingsStore } from "../settings.ts";
import { resolveFromBase } from "./dirs.ts";
import type {
	PackageContext,
	PackageFilter,
	PathMetadata,
	ResolvedPaths,
	ResolvedResource,
	ResourceAccumulator,
	ResourceMap,
} from "./types.ts";

export function createAccumulator(): ResourceAccumulator {
	return {
		extensions: new Map(),
		skills: new Map(),
		prompts: new Map(),
		themes: new Map(),
	};
}

export function addResource(
	map: ResourceMap,
	path: string,
	metadata: PathMetadata,
	enabled: boolean,
): void {
	if (!path) return;
	if (!map.has(path)) {
		map.set(path, { metadata, enabled });
	}
}

export function getTargetMap(
	accumulator: ResourceAccumulator,
	resourceType: ResourceType,
): ResourceMap {
	switch (resourceType) {
		case "extensions":
			return accumulator.extensions;
		case "skills":
			return accumulator.skills;
		case "prompts":
			return accumulator.prompts;
		case "themes":
			return accumulator.themes;
		default:
			throw new Error(`Unknown resource type: ${resourceType}`);
	}
}

export function toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
	const mapToResolved = (entries: ResourceMap): ResolvedResource[] => {
		const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
			path,
			enabled,
			metadata,
		}));
		resolved.sort(
			(a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata),
		);

		const seen = new Set<string>();
		return resolved.filter((entry) => {
			const canonicalPath = canonicalizePath(entry.path);
			if (seen.has(canonicalPath)) return false;
			seen.add(canonicalPath);
			return true;
		});
	};

	return {
		extensions: mapToResolved(accumulator.extensions),
		skills: mapToResolved(accumulator.skills),
		prompts: mapToResolved(accumulator.prompts),
		themes: mapToResolved(accumulator.themes),
	};
}

export function collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
	const files: string[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;

		try {
			const stats = statSync(p);
			if (stats.isFile()) {
				files.push(p);
			} else if (stats.isDirectory()) {
				files.push(...collectResourceFiles(p, resourceType));
			}
		} catch {}
	}
	return files;
}

export function collectPackageResources(
	packageRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): boolean {
	if (filter) {
		for (const resourceType of RESOURCE_TYPES) {
			const patterns = filter[resourceType];
			const target = getTargetMap(accumulator, resourceType);
			if (filter.autoload === false) {
				applyPackageDeltaFilter(packageRoot, patterns ?? [], resourceType, target, metadata);
			} else if (patterns !== undefined) {
				applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
			} else {
				collectDefaultResources(packageRoot, resourceType, target, metadata);
			}
		}
		return true;
	}

	const manifest = readGamaManifest(join(packageRoot, "package.json"));
	if (manifest) {
		for (const resourceType of RESOURCE_TYPES) {
			const entries = manifest[resourceType as keyof GamaManifest];
			addManifestEntries(
				entries,
				packageRoot,
				resourceType,
				getTargetMap(accumulator, resourceType),
				metadata,
			);
		}
		return true;
	}

	let hasAnyDir = false;
	for (const resourceType of RESOURCE_TYPES) {
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				addResource(getTargetMap(accumulator, resourceType), f, metadata, true);
			}
			hasAnyDir = true;
		}
	}
	return hasAnyDir;
}

function collectDefaultResources(
	packageRoot: string,
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
): void {
	const manifest = readGamaManifest(join(packageRoot, "package.json"));
	const entries = manifest?.[resourceType as keyof GamaManifest];
	if (entries) {
		addManifestEntries(entries, packageRoot, resourceType, target, metadata);
		return;
	}
	const dir = join(packageRoot, resourceType);
	if (existsSync(dir)) {
		const files = collectResourceFiles(dir, resourceType);
		for (const f of files) {
			addResource(target, f, metadata, true);
		}
	}
}

function applyPackageFilter(
	packageRoot: string,
	userPatterns: string[],
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
): void {
	const { allFiles } = collectManifestFiles(packageRoot, resourceType);

	if (userPatterns.length === 0) {
		for (const f of allFiles) {
			addResource(target, f, metadata, false);
		}
		return;
	}

	const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

	for (const f of allFiles) {
		const enabled = enabledByUser.has(f);
		addResource(target, f, metadata, enabled);
	}
}

function applyPackageDeltaFilter(
	packageRoot: string,
	userPatterns: string[],
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
): void {
	if (userPatterns.length === 0) {
		return;
	}

	const { allFiles } = collectManifestFiles(packageRoot, resourceType);
	const enabledByUser = applyAutoloadDisabledPatterns(allFiles, userPatterns, packageRoot);
	for (const [filePath, enabled] of enabledByUser) {
		addResource(target, filePath, metadata, enabled);
	}
}

function collectManifestFiles(
	packageRoot: string,
	resourceType: ResourceType,
): { allFiles: string[]; enabledByManifest: Set<string> } {
	const manifest = readGamaManifest(join(packageRoot, "package.json"));
	const entries = manifest?.[resourceType as keyof GamaManifest];
	if (entries && entries.length > 0) {
		const allFiles = collectFilesFromManifestEntries(entries, packageRoot, resourceType);
		const manifestPatterns = entries.filter(isOverridePattern);
		const enabledByManifest =
			manifestPatterns.length > 0
				? applyPatterns(allFiles, manifestPatterns, packageRoot)
				: new Set(allFiles);
		return { allFiles: Array.from(enabledByManifest), enabledByManifest };
	}

	const conventionDir = join(packageRoot, resourceType);
	if (!existsSync(conventionDir)) {
		return { allFiles: [], enabledByManifest: new Set() };
	}
	const allFiles = collectResourceFiles(conventionDir, resourceType);
	return { allFiles, enabledByManifest: new Set(allFiles) };
}

function addManifestEntries(
	entries: string[] | undefined,
	root: string,
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
): void {
	if (!entries) return;

	const allFiles = collectFilesFromManifestEntries(entries, root, resourceType);
	const patterns = entries.filter(isOverridePattern);
	const enabledPaths = applyPatterns(allFiles, patterns, root);

	for (const f of allFiles) {
		if (enabledPaths.has(f)) {
			addResource(target, f, metadata, true);
		}
	}
}

function collectFilesFromManifestEntries(
	entries: string[],
	root: string,
	resourceType: ResourceType,
): string[] {
	const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
	const resolved = sourceEntries
		.flatMap((entry) => {
			if (!hasGlobPattern(entry)) {
				return [resolve(root, entry)];
			}

			return expandPackageGlob(entry, root);
		})
		// Outside root
		.filter((file) => {
			const rel = relative(root, file);
			return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
		});
	return collectFilesFromPaths(resolved, resourceType);
}

export function resolveLocalEntries(
	entries: string[],
	resourceType: ResourceType,
	target: ResourceMap,
	metadata: PathMetadata,
	baseDir: string,
): void {
	if (entries.length === 0) return;

	const { plain, patterns } = splitPatterns(entries);
	const resolvedPlain = plain.map((p) => resolveFromBase(p, baseDir));
	const allFiles = collectFilesFromPaths(resolvedPlain, resourceType);

	const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

	for (const f of allFiles) {
		addResource(target, f, metadata, enabledPaths.has(f));
	}
}

export interface AutoDiscoveryInput {
	ctx: PackageContext;
	accumulator: ResourceAccumulator;
	globalSettings: ReturnType<SettingsStore["getGlobalSettings"]>;
	projectSettings: ReturnType<SettingsStore["getProjectSettings"]>;
	globalBaseDir: string;
	projectBaseDir: string;
}

export function addAutoDiscoveredResources(input: AutoDiscoveryInput): void {
	const { ctx, accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir } =
		input;
	const userMetadata: PathMetadata = {
		source: "auto",
		scope: "user",
		origin: "top-level",
		baseDir: globalBaseDir,
	};
	const projectMetadata: PathMetadata = {
		source: "auto",
		scope: "project",
		origin: "top-level",
		baseDir: projectBaseDir,
	};

	const userOverrides = {
		extensions: (globalSettings.extensions ?? []) as string[],
		skills: (globalSettings.skills ?? []) as string[],
		prompts: (globalSettings.prompts ?? []) as string[],
		themes: (globalSettings.themes ?? []) as string[],
	};
	const projectOverrides = {
		extensions: (projectSettings.extensions ?? []) as string[],
		skills: (projectSettings.skills ?? []) as string[],
		prompts: (projectSettings.prompts ?? []) as string[],
		themes: (projectSettings.themes ?? []) as string[],
	};

	const userDirs = {
		extensions: join(globalBaseDir, "extensions"),
		skills: join(globalBaseDir, "skills"),
		prompts: join(globalBaseDir, "prompts"),
		themes: join(globalBaseDir, "themes"),
	};
	const projectDirs = {
		extensions: join(projectBaseDir, "extensions"),
		skills: join(projectBaseDir, "skills"),
		prompts: join(projectBaseDir, "prompts"),
		themes: join(projectBaseDir, "themes"),
	};
	const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
	const projectTrusted = ctx.settings.isProjectTrusted();
	const projectAgentsSkillDirs = projectTrusted
		? collectAncestorAgentsSkillDirs(ctx.cwd).filter(
				(dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
			)
		: [];

	const addResources = (
		resourceType: ResourceType,
		paths: string[],
		metadata: PathMetadata,
		overrides: string[],
		baseDir: string,
	) => {
		const target = getTargetMap(accumulator, resourceType);
		for (const path of paths) {
			const enabled = isEnabledByOverrides(path, overrides, baseDir);
			addResource(target, path, metadata, enabled);
		}
	};

	if (projectTrusted) {
		addResources(
			"extensions",
			collectAutoExtensionEntries(projectDirs.extensions),
			projectMetadata,
			projectOverrides.extensions,
			projectBaseDir,
		);

		addResources(
			"skills",
			collectAutoSkillEntries(projectDirs.skills, "gama"),
			projectMetadata,
			projectOverrides.skills,
			projectBaseDir,
		);
	}

	for (const agentsSkillsDir of projectAgentsSkillDirs) {
		const agentsBaseDir = dirname(agentsSkillsDir);
		const agentsMetadata: PathMetadata = {
			...projectMetadata,
			baseDir: agentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(agentsSkillsDir, "agents"),
			agentsMetadata,
			projectOverrides.skills,
			agentsBaseDir,
		);
	}

	if (projectTrusted) {
		addResources(
			"prompts",
			collectAutoPromptEntries(projectDirs.prompts),
			projectMetadata,
			projectOverrides.prompts,
			projectBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(projectDirs.themes),
			projectMetadata,
			projectOverrides.themes,
			projectBaseDir,
		);
	}

	addResources(
		"extensions",
		collectAutoExtensionEntries(userDirs.extensions),
		userMetadata,
		userOverrides.extensions,
		globalBaseDir,
	);

	addResources(
		"skills",
		collectAutoSkillEntries(userDirs.skills, "gama"),
		userMetadata,
		userOverrides.skills,
		globalBaseDir,
	);

	const userAgentsBaseDir = dirname(userAgentsSkillsDir);
	const userAgentsMetadata: PathMetadata = {
		...userMetadata,
		baseDir: userAgentsBaseDir,
	};
	addResources(
		"skills",
		collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
		userAgentsMetadata,
		userOverrides.skills,
		userAgentsBaseDir,
	);

	addResources(
		"prompts",
		collectAutoPromptEntries(userDirs.prompts),
		userMetadata,
		userOverrides.prompts,
		globalBaseDir,
	);
	addResources(
		"themes",
		collectAutoThemeEntries(userDirs.themes),
		userMetadata,
		userOverrides.themes,
		globalBaseDir,
	);
}
