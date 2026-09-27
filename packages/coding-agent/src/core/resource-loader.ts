import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
	detectCapabilities,
	getTerminalColorMode,
	type TerminalColorMode,
} from "@huranth/gama-tui";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/tui/theme/theme.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import {
	clearExtensionCache,
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensionsCached,
} from "./ext/loader.ts";
import type {
	Extension,
	ExtensionFactory,
	ExtensionRuntime,
	InlineExtension,
	LoadExtensionsResult,
} from "./ext/types.ts";
import { findGitPaths } from "./footer-data-provider.ts";
import {
	DefaultPackageManager,
	type PathMetadata,
	type ResolvedResource,
} from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import {
	BUILTIN_PATH_PREFIX,
	createSourceInfo,
	getSyntheticPathSource,
	isSyntheticPath,
	type SourceInfo,
} from "./source-info.ts";
import { resetTimings } from "./timings.ts";

const HOST_PROVIDED_EXTENSION_PACKAGES = new Set([
	"@huranth/gama-agent-core",
	"@huranth/gama-ai",
	"@huranth/gama-harness",
	"@huranth/gama-tui",
	"@sinclair/typebox",
	"typebox",
]);

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderReloadOptions {
	resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
}

type BuiltinExtension = Exclude<InlineExtension, ExtensionFactory>;

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getSystemPromptSource(): { path: string } | undefined;
	getAppendSystemPrompt(): string[];
	getAppendSystemPromptSources(): Array<{ path: string }>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: InlineExtension[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export function isBuiltinExtension(input: InlineExtension): input is BuiltinExtension {
	return typeof input !== "function" && input.builtin === true;
}

function mergeExtensionWarnings(
	result: LoadExtensionsResult,
	warnings: Array<{ path: string; warning: string }>,
): void {
	result.warnings = [
		...new Map(
			[...(result.warnings ?? []), ...warnings].map((warning) => [warning.path, warning]),
		).values(),
	];
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return stripBom(readFileSync(input, "utf-8"));
		} catch (error) {
			console.error(
				chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`),
			);
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}

	return null;
}

function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;

	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	const isLinkedWorktree = worktreeRoot.startsWith(`${mainRepoRoot}${sep}`);
	const hasRepoGitDir = canonicalizePath(join(mainRepoRoot, ".git")) === commonGitDir;

	if (!isLinkedWorktree || !hasRepoGitDir) return undefined;

	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	if (!worktreeContextFile) return undefined;

	return join(mainRepoRoot, basename(worktreeContextFile.path));
}

function isPathWithin(target: string, root: string): boolean {
	return target === root || target.startsWith(`${root}${sep}`);
}

function collectConflicts(
	names: Iterable<string>,
	owners: Map<string, string>,
	extensionPath: string,
	label: (name: string) => string,
	conflicts: Array<{ path: string; message: string }>,
): void {
	for (const name of names) {
		const owner = owners.get(name);

		if (owner && owner !== extensionPath) {
			conflicts.push({ path: extensionPath, message: `${label(name)} conflicts with ${owner}` });
			continue;
		}

		owners.set(name, extensionPath);
	}
}

function getRegisteredNames(extension: Extension): string[] {
	return [
		...[...extension.tools.keys()].map((name) => `tool:${name}`),
		...[...extension.commands.keys()].map((name) => `command:${name}`),
		...[...extension.flags.keys()].map((name) => `flag:${name}`),
	];
}

function findReplacement(
	extension: Extension,
	taken: Map<string, Extension>,
): { name: string; extension: Extension } | undefined {
	for (const name of getRegisteredNames(extension)) {
		const owner = taken.get(name);
		if (owner) return { name, extension: owner };
	}

	return undefined;
}

function omitReplacedExtensions(
	extensions: Extension[],
	warnings?: Array<{ path: string; warning: string }>,
): Extension[] {
	const taken = new Map(
		extensions
			.filter((extension) => !extension.replaceable)
			.flatMap((extension) =>
				getRegisteredNames(extension).map((name) => [name, extension] as const),
			),
	);

	return extensions.filter((extension) => {
		if (!extension.replaceable) return true;

		const replacement = findReplacement(extension, taken);
		if (!replacement) return true;
		if (extension.path.startsWith(BUILTIN_PATH_PREFIX)) {
			const builtinName = extension.path.slice(BUILTIN_PATH_PREFIX.length);
			const [kind, rawName] = replacement.name.split(":", 2);
			const registeredName =
				kind === "command" ? `/${rawName}` : kind === "flag" ? `--${rawName}` : rawName;
			warnings?.push({
				path: extension.path,
				warning:
					`Extension ${replacement.extension.path} registers ${kind} \`${registeredName}\`, ` +
					`so built-in extension \`${builtinName}\` was not loaded. ` +
					`To use \`${builtinName}\`, run \`gama config\` and make sure it is ` +
					"enabled under Built-in extensions, then disable or remove the existing extension. " +
					"We recommend only having one or the other loaded at a time.",
			});
		}
		return false;
	});
}

function collectExtensionPackageWarnings(
	extensionPaths: string[],
	metadataByPath: Map<string, PathMetadata>,
): Array<{ path: string; warning: string }> {
	const warnings: Array<{ path: string; warning: string }> = [];
	const packageRoots = new Set(
		extensionPaths
			.map((extensionPath) => metadataByPath.get(extensionPath)?.packageRoot)
			.filter((packageRoot): packageRoot is string => packageRoot !== undefined),
	);

	for (const packageRoot of packageRoots) {
		const packageJsonPath = join(packageRoot, "package.json");
		if (!existsSync(packageJsonPath)) continue;

		const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as {
			dependencies?: unknown;
		};
		const dependencies = manifest.dependencies;
		if (typeof dependencies !== "object" || dependencies === null) continue;
		if (Array.isArray(dependencies)) continue;

		const hostDependencies = Object.keys(dependencies)
			.filter((name) => HOST_PROVIDED_EXTENSION_PACKAGES.has(name))
			.sort();
		if (hostDependencies.length === 0) continue;

		warnings.push({
			path: packageJsonPath,
			warning:
				`Host-provided extension packages must be declared in peerDependencies ` +
				`with a "*" range, not dependencies: ${hostDependencies.join(", ")}. ` +
				"Installed copies can bypass the extension loader and create duplicate runtime modules.",
		});
	}

	return warnings;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		const isShadowed =
			shadowedContextFile !== undefined &&
			canonicalizePath(contextFile?.path ?? "") === shadowedContextFile;
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: InlineExtension[];
	private builtinExtensions: Map<string, BuiltinExtension>;
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	}) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: {
		agentsFiles: Array<{ path: string; content: string }>;
	}) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private systemPromptSourcePath?: string;
	private appendSystemPrompt: string[];
	private appendSystemPromptSourcePaths: string[];
	private lastSkillPaths: string[];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private resourceMetadataByPath: Map<string, PathMetadata>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];
	private loaded: boolean;

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager =
			options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		const factories = options.extensionFactories ?? [];
		this.extensionFactories = factories.filter((input) => !isBuiltinExtension(input));
		this.builtinExtensions = new Map(
			factories.filter(isBuiltinExtension).map((input) => [input.name, input]),
		);
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			builtinExtensions: [...this.builtinExtensions.keys()],
		});
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.appendSystemPromptSourcePaths = [];
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.resourceMetadataByPath = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
		this.loaded = false;
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getSystemPromptSource(): { path: string } | undefined {
		return this.systemPromptSourcePath ? { path: this.systemPromptSourcePath } : undefined;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	getAppendSystemPromptSources(): Array<{ path: string }> {
		return this.appendSystemPromptSourcePaths.map((path) => ({ path }));
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(
				entry.path,
				createSourceInfo(entry.path, entry.metadata),
			);
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(
				entry.path,
				createSourceInfo(entry.path, entry.metadata),
			);
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(
				entry.path,
				createSourceInfo(entry.path, entry.metadata),
			);
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths, this.resourceMetadataByPath);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths, this.resourceMetadataByPath);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths, this.resourceMetadataByPath);
		}
	}

	private reportMissingAdditionalPaths(
		paths: string[],
		diagnostics: ResourceDiagnostic[],
		message: string,
		localOnly = true,
	): void {
		for (const path of paths) {
			if (localOnly && !isLocalPath(path)) continue;

			const resolved = this.resolveResourcePath(path);
			const missing = !existsSync(resolved);
			const alreadyReported = diagnostics.some((entry) => entry.path === resolved);

			if (missing && !alreadyReported) {
				diagnostics.push({ type: "error", message, path: resolved });
			}
		}
	}

	async loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {
		this.settingsManager.setProjectTrusted(false);
		await this.settingsManager.reload();
		return this.loadCurrentExtensionSet({ includeInlineFactories: true });
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		resetTimings("extensions");

		if (this.loaded) {
			clearExtensionCache();
		}

		let preTrustExtensions: LoadExtensionsResult | undefined;
		if (options?.resolveProjectTrust) {
			preTrustExtensions = await this.loadProjectTrustExtensions();
			const projectTrusted = await options.resolveProjectTrust({
				extensionsResult: preTrustExtensions,
			});
			this.settingsManager.setProjectTrusted(projectTrusted);
		}

		await this.settingsManager.reload();
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(
			this.additionalExtensionPaths,
			{
				temporary: true,
			},
		);
		this.resourceMetadataByPath = new Map();
		const metadataByPath = this.resourceMetadataByPath;

		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		const getEnabledResources = (resources: ResolvedResource[]): ResolvedResource[] => {
			for (const resource of resources) {
				if (!metadataByPath.has(resource.path)) {
					metadataByPath.set(resource.path, resource.metadata);
				}
			}
			return resources.filter((resource) => resource.enabled);
		};

		const getEnabledPaths = (resources: ResolvedResource[]): string[] =>
			getEnabledResources(resources).map((resource) => resource.path);
		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		const enabledSkills = enabledSkillResources.map((resource) =>
			this.mapSkillPath(resource, metadataByPath),
		);

		const cliResources = [...cliExtensionPaths.extensions, ...cliExtensionPaths.skills];
		for (const resource of cliResources) {
			if (!metadataByPath.has(resource.path)) {
				metadataByPath.set(resource.path, {
					source: "cli",
					scope: "temporary",
					origin: "top-level",
				});
			}
		}

		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

		const extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);

		const packageWarnings = collectExtensionPackageWarnings(extensionPaths, metadataByPath);
		const extensionsResult = await this.loadFinalExtensionSet(extensionPaths, preTrustExtensions);
		mergeExtensionWarnings(extensionsResult, packageWarnings);
		for (const path of this.additionalExtensionPaths) {
			if (isLocalPath(path)) {
				const resolved = this.resolveResourcePath(path);
				if (!existsSync(resolved)) {
					extensionsResult.errors.push({
						path: resolved,
						error: `Extension path does not exist: ${resolved}`,
					});
				}
			}
		}
		this.extensionsResult = this.extensionsOverride
			? this.extensionsOverride(extensionsResult)
			: extensionsResult;
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

		const skillPaths = this.noSkills
			? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
			: this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);

		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		this.reportMissingAdditionalPaths(
			this.additionalSkillPaths,
			this.skillDiagnostics,
			"Skill path does not exist",
		);

		const promptPaths = this.noPromptTemplates
			? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
			: this.mergePaths(
					[...cliEnabledPrompts, ...enabledPrompts],
					this.additionalPromptTemplatePaths,
				);

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		this.reportMissingAdditionalPaths(
			this.additionalPromptTemplatePaths,
			this.promptDiagnostics,
			"Prompt template path does not exist",
		);

		const themePaths = this.noThemes
			? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
			: this.mergePaths([...cliEnabledThemes, ...enabledThemes], this.additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		this.reportMissingAdditionalPaths(
			this.additionalThemePaths,
			this.themeDiagnostics,
			"Theme path does not exist",
			false,
		);

		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
					}),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride
			? this.agentsFilesOverride(agentsFiles)
			: agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		const systemPromptSource = this.systemPromptSource ?? this.discoverSystemPromptFile();
		const baseSystemPrompt = resolvePromptInput(systemPromptSource, "system prompt");
		this.systemPrompt = this.systemPromptOverride
			? this.systemPromptOverride(baseSystemPrompt)
			: baseSystemPrompt;
		this.systemPromptSourcePath =
			systemPromptSource && existsSync(systemPromptSource)
				? resolvePath(systemPromptSource)
				: undefined;

		let appendSources = this.appendSystemPromptSource;
		if (!appendSources) {
			const discoveredAppendSystemPromptFile = this.discoverAppendSystemPromptFile();
			appendSources = discoveredAppendSystemPromptFile ? [discoveredAppendSystemPromptFile] : [];
		}
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
		this.appendSystemPromptSourcePaths = appendSources
			.filter((source) => existsSync(source))
			.map((source) => resolvePath(source));
		this.loaded = true;
	}

	private async loadCurrentExtensionSet(options: {
		includeInlineFactories: boolean;
	}): Promise<LoadExtensionsResult> {
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(
			this.additionalExtensionPaths,
			{
				temporary: true,
			},
		);
		const enabledExtensions = resolvedPaths.extensions
			.filter((r) => r.enabled)
			.map((r) => r.path);
		const cliEnabledExtensions = cliExtensionPaths.extensions
			.filter((r) => r.enabled)
			.map((r) => r.path);
		const extensionPaths = (
			this.noExtensions
				? cliEnabledExtensions
				: this.mergePaths(cliEnabledExtensions, enabledExtensions)
		).filter((path) => !path.startsWith(BUILTIN_PATH_PREFIX));
		const metadataByPath = new Map(
			[...resolvedPaths.extensions, ...cliExtensionPaths.extensions].map((resource) => [
				resource.path,
				resource.metadata,
			]),
		);
		const packageWarnings = collectExtensionPackageWarnings(extensionPaths, metadataByPath);
		const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);
		mergeExtensionWarnings(extensionsResult, packageWarnings);
		if (!options.includeInlineFactories) {
			return extensionsResult;
		}

		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		const replacementWarnings: Array<{ path: string; warning: string }> = [];
		extensionsResult.extensions = omitReplacedExtensions(
			extensionsResult.extensions,
			replacementWarnings,
		);
		mergeExtensionWarnings(extensionsResult, replacementWarnings);
		return extensionsResult;
	}

	private resolveExtensionLoadPath(path: string): string {
		return isSyntheticPath(path)
			? path
			: resolvePath(path, this.cwd, { normalizeUnicodeSpaces: true });
	}

	private async loadExtensionPaths(
		paths: string[],
		runtime?: ExtensionRuntime,
	): Promise<LoadExtensionsResult> {
		const isBuiltinPath = (path: string) => path.startsWith(BUILTIN_PATH_PREFIX);
		const result = await loadExtensionsCached(
			paths.filter((path) => !isBuiltinPath(path)),
			this.cwd,
			this.eventBus,
			runtime,
		);
		for (const path of paths.filter(isBuiltinPath)) {
			const builtin = this.builtinExtensions.get(path.slice(BUILTIN_PATH_PREFIX.length));
			if (!builtin) {
				result.errors.push({ path, error: `Unknown built-in extension: ${path}` });
				continue;
			}
			try {
				const extension = await loadExtensionFromFactory(
					builtin.factory,
					this.cwd,
					this.eventBus,
					result.runtime,
					path,
				);
				extension.hidden = true;
				extension.replaceable = builtin.replaceable === true;
				result.extensions.push(extension);
			} catch (error) {
				result.errors.push({
					path,
					error: error instanceof Error ? error.message : "failed to load extension",
				});
			}
		}
		return result;
	}

	private async loadFinalExtensionSet(
		extensionPaths: string[],
		preTrustExtensions: LoadExtensionsResult | undefined,
	): Promise<LoadExtensionsResult> {
		const preloaded = preTrustExtensions?.extensions ?? [];
		const preloadedByPath = new Map(
			preloaded
				.filter((extension) => !extension.path.startsWith("<inline:"))
				.map((extension) => [extension.resolvedPath, extension]),
		);
		const failedPreloadPaths = new Set(
			(preTrustExtensions?.errors ?? []).map((error) =>
				this.resolveExtensionLoadPath(error.path),
			),
		);
		const remainingPaths = extensionPaths.filter((path) => {
			const resolvedPath = this.resolveExtensionLoadPath(path);
			return !preloadedByPath.has(resolvedPath) && !failedPreloadPaths.has(resolvedPath);
		});
		const remainingExtensions = await this.loadExtensionPaths(
			remainingPaths,
			preTrustExtensions?.runtime,
		);
		const loadedByPath = new Map(preloadedByPath);
		for (const extension of remainingExtensions.extensions) {
			loadedByPath.set(extension.resolvedPath, extension);
		}

		const inlineExtensions = preTrustExtensions
			? {
					extensions: preloaded.filter((extension) => extension.path.startsWith("<inline:")),
					errors: [],
				}
			: await this.loadExtensionFactories(remainingExtensions.runtime);
		const orderedExtensions = extensionPaths
			.map((path) => loadedByPath.get(this.resolveExtensionLoadPath(path)))
			.filter((extension): extension is Extension => extension !== undefined);
		orderedExtensions.push(...inlineExtensions.extensions);

		const replacementWarnings: Array<{ path: string; warning: string }> = [];
		const extensionsResult: LoadExtensionsResult = {
			extensions: omitReplacedExtensions(orderedExtensions, replacementWarnings),
			errors: [
				...(preTrustExtensions?.errors ?? []),
				...remainingExtensions.errors,
				...inlineExtensions.errors,
			],
			warnings: [
				...(preTrustExtensions?.warnings ?? []),
				...(remainingExtensions.warnings ?? []),
			],
			runtime: remainingExtensions.runtime,
		};
		mergeExtensionWarnings(extensionsResult, replacementWarnings);
		this.addExtensionConflictDiagnostics(extensionsResult);
		return extensionsResult;
	}

	private addExtensionConflictDiagnostics(extensionsResult: LoadExtensionsResult): void {
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}
	}

	private mapSkillPath(
		resource: ResolvedResource,
		metadataByPath: Map<string, PathMetadata>,
	): string {
		if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
			return resource.path;
		}

		let isDirectory = false;
		try {
			isDirectory = statSync(resource.path).isDirectory();
		} catch {
			return resource.path;
		}

		if (!isDirectory) return resource.path;

		const skillFile = join(resource.path, "SKILL.md");
		if (!existsSync(skillFile)) return resource.path;

		if (!metadataByPath.has(skillFile)) metadataByPath.set(skillFile, resource.metadata);

		return skillFile;
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	private updateSkillsFromPaths(
		skillPaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(
					skill.filePath,
					this.extensionSkillSourceInfos,
					metadataByPath,
				) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updatePromptsFromPaths(
		promptPaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const loaded = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			const deduped = this.dedupePrompts(loaded.templates);
			promptsResult = {
				prompts: deduped.prompts,
				diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
			};
		}
		const resolvedPrompts = this.promptsOverride
			? this.promptsOverride(promptsResult)
			: promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(
					prompt.filePath,
					this.extensionPromptSourceInfos,
					metadataByPath,
				) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updateThemesFromPaths(
		themePaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const colorMode = getTerminalColorMode({
				...detectCapabilities(() => false),
				...this.settingsManager.getTerminalCapabilityOverrides(),
			});
			const loaded = this.loadThemes(themePaths, false, colorMode);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = {
				themes: deduped.themes,
				diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
			};
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(
						sourcePath,
						this.extensionThemeSourceInfos,
						metadataByPath,
					) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	private applyExtensionSourceInfo(
		extensions: Extension[],
		metadataByPath: Map<string, PathMetadata>,
	): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (isSyntheticPath(resourcePath)) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);

		if (extraSourceInfos) {
			for (const [sourcePath, sourceInfo] of extraSourceInfos) {
				if (isPathWithin(normalizedResourcePath, resolve(sourcePath))) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		if (metadataByPath) {
			const exact =
				metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) return createSourceInfo(resourcePath, exact);

			for (const [sourcePath, metadata] of metadataByPath) {
				if (isPathWithin(normalizedResourcePath, resolve(sourcePath))) {
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		const syntheticSource = getSyntheticPathSource(filePath);
		if (syntheticSource) {
			return {
				path: filePath,
				source: syntheticSource,
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		const localSourceInfo = (root: string, scope: "user" | "project"): SourceInfo => ({
			path: filePath,
			source: "local",
			scope,
			origin: "top-level",
			baseDir: root,
		});

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) return localSourceInfo(root, "user");
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) return localSourceInfo(root, "project");
		}

		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory()
				? normalizedPath
				: resolve(normalizedPath, ".."),
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const path of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(path);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		return isSyntheticPath(p) ? p : resolvePath(p, this.cwd, { trim: true });
	}

	private loadThemes(
		paths: string[],
		includeDefaults: boolean,
		colorMode: TerminalColorMode,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [
				join(this.agentDir, "themes"),
				join(this.cwd, CONFIG_DIR_NAME, "themes"),
			];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics, colorMode);
			}
		}

		for (const path of paths) {
			const resolved = this.resolveResourcePath(path);
			if (!existsSync(resolved)) {
				diagnostics.push({
					type: "warning",
					message: "theme path does not exist",
					path: resolved,
				});
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics, colorMode);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics, colorMode);
				} else {
					diagnostics.push({
						type: "warning",
						message: "theme path is not a json file",
						path: resolved,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(
		dir: string,
		themes: Theme[],
		diagnostics: ResourceDiagnostic[],
		colorMode: TerminalColorMode,
	): void {
		if (!existsSync(dir)) {
			return;
		}
		try {
			const entries = readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				let isFile = entry.isFile();

				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}

				if (!isFile || !entry.name.endsWith(".json")) continue;

				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics, colorMode);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(
		filePath: string,
		themes: Theme[],
		diagnostics: ResourceDiagnostic[],
		colorMode: TerminalColorMode,
	): void {
		try {
			themes.push(loadThemeFromPath(filePath, colorMode));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, input] of this.extensionFactories.entries()) {
			const isNamed = typeof input !== "function";
			const factory = isNamed ? input.factory : input;
			const extensionPath = `<inline:${isNamed ? input.name : index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(
					factory,
					this.cwd,
					this.eventBus,
					runtime,
					extensionPath,
				);
				extension.hidden = isNamed && input.hidden;
				extension.replaceable = isNamed && input.replaceable === true;
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private dedupePrompts(prompts: PromptTemplate[]): {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	} {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const theme of themes) {
			const name = theme.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: theme.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: theme.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, theme);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	private detectExtensionConflicts(
		extensions: Extension[],
	): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const extension of extensions) {
			collectConflicts(
				extension.tools.keys(),
				toolOwners,
				extension.path,
				(name) => `Tool "${name}"`,
				conflicts,
			);
			collectConflicts(
				extension.flags.keys(),
				flagOwners,
				extension.path,
				(name) => `Flag "--${name}"`,
				conflicts,
			);
		}

		return conflicts;
	}
}
