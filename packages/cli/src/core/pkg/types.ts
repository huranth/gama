import type { GitSource } from "../../utils/git.ts";
import type { SettingsStore } from "../settings.ts";

export type SourceScope = "user" | "project" | "temporary";

export type InstalledSourceScope = Exclude<SourceScope, "temporary">;

export type MissingSourceAction = "install" | "skip" | "error";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	packageRoot?: string;
}

export interface ResourceEntry {
	metadata: PathMetadata;
	enabled: boolean;
}

export type ResourceMap = Map<string, ResourceEntry>;

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export interface ProgressEvent {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: InstalledSourceScope;
}

export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}

export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

export interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsStore;
	builtinExtensions?: string[];
}

export type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
	range?: string;
	pinned: boolean;
};

export type LocalSource = {
	type: "local";
	path: string;
};

export type ParsedSource = NpmSource | GitSource | LocalSource;

export interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

export interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
}

export interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

export interface ResourceAccumulator {
	extensions: ResourceMap;
	skills: ResourceMap;
	prompts: ResourceMap;
	themes: ResourceMap;
}

export interface PackageFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export interface CaptureOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

export interface CommandRunner {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandCapture(command: string, args: string[], options?: CaptureOptions): Promise<string>;
	runCommandSync(command: string, args: string[]): string;
}

export interface NpmRootCache {
	root?: string;
	key?: string;
}

export interface PackageContext extends CommandRunner {
	cwd: string;
	agentDir: string;
	settings: SettingsStore;
	builtinExtensions: string[];
	npmRoot: NpmRootCache;
	emit(event: ProgressEvent): void;
	withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void>;
}
