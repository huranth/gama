import {
	chmodSync,
	existsSync,
	globSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { valid, validRange } from "semver";
import { readGamaManifest } from "./gama-manifest.ts";
import type { PathMetadata } from "./package-manager.ts";

export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export type IgnoreMatcher = ReturnType<typeof ignore>;

export type SkillDiscoveryMode = "gama" | "agents";

export const NETWORK_TIMEOUT_MS = 10000;
export const UPDATE_CHECK_CONCURRENCY = 4;
export const GIT_UPDATE_CONCURRENCY = 4;

export const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

export const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

export const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function getSkillParentPaths(
	filePath: string,
	baseDir: string,
): { rel: string; name: string; posix: string } | undefined {
	if (basename(filePath) !== "SKILL.md") return undefined;

	const parentDir = dirname(filePath);

	return {
		rel: toPosixPath(relative(baseDir, parentDir)),
		name: basename(parentDir),
		posix: toPosixPath(parentDir),
	};
}

export function getExtensionTempFolder(agentDir: string): string {
	const tempFolder = join(agentDir, "tmp", "extensions");
	mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
	chmodSync(tempFolder, 0o700);
	return tempFolder;
}

export function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	return collectFilesInternal(
		dir,
		filePattern,
		skipNodeModules,
		ignoreMatcher,
		rootDir,
		new Set(),
	);
}

export function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	return collectSkillEntriesInternal(dir, mode, ignoreMatcher, rootDir, new Set());
}

export function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

export function isExactNpmVersion(version: string | undefined): boolean {
	return valid(version ?? "") !== null;
}

export function getNpmVersionRange(version: string | undefined): string | undefined {
	return version ? (validRange(version) ?? undefined) : undefined;
}

export function getHomeDir(): string {
	return process.env.HOME || homedir();
}

export function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

export function expandPackageGlob(pattern: string, root: string): string[] {
	const isInsideRoot = (path: string): boolean => {
		const segments = relative(root, path).split(sep);

		return segments.every((segment) => segment !== ".." && !segment.startsWith("."));
	};

	return globSync(pattern, { cwd: root })
		.map((match) => resolve(root, match))
		.filter(isInsideRoot)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function normalizeExactPattern(pattern: string): string {
	const normalized =
		pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

export function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function markDirectoryVisited(path: string, visited: Set<string>): boolean {
	let key = path;
	try {
		key = realpathSync(path);
	} catch {
		// Raw fallback
	}
	if (visited.has(key)) return false;
	visited.add(key);
	return true;
}

export function getOverridePatterns(entries: string[]): string[] {
	return entries.filter(
		(pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"),
	);
}

export function isOfflineModeEnabled(): boolean {
	const value = process.env.GAMA_OFFLINE;
	if (!value) return false;

	const normalized = value.toLowerCase();

	return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.source === "builtin") return 5;
	if (m.origin === "package") return 4;

	const scopeBase = m.scope === "project" ? 0 : 2;
	const sourceRank = m.source === "local" ? 0 : 1;

	return scopeBase + sourceRank;
}

export function isPattern(s: string): boolean {
	return (
		s.startsWith("!") ||
		s.startsWith("+") ||
		s.startsWith("-") ||
		s.includes("*") ||
		s.includes("?")
	);
}

export function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

export function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "gama");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));

			if (patterns.length > 0) ig.add(patterns);
		} catch {}
	}
}

export function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);

	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;

		const parent = dirname(dir);
		if (parent === dir) return null;

		dir = parent;
	}
}

export function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}

	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};

		for (const entry of data.split("\0")) {
			const separator = entry.indexOf("=");
			if (separator <= 0) continue;

			const name = entry.slice(0, separator);
			env[name] = entry.slice(separator + 1);
		}

		return env;
	} catch {
		return process.env;
	}
}

export function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;

	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) break;

		const parent = dirname(dir);
		if (parent === dir) break;

		dir = parent;
	}

	return skillDirs;
}

export function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const parent = getSkillParentPaths(filePath, baseDir);

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		const directMatch =
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern);

		if (directMatch) return true;
		if (!parent) return false;

		return (
			minimatch(parent.rel, normalizedPattern) ||
			minimatch(parent.name, normalizedPattern) ||
			minimatch(parent.posix, normalizedPattern)
		);
	});
}

export function matchesAnyExactPattern(
	filePath: string,
	patterns: string[],
	baseDir: string,
): boolean {
	if (patterns.length === 0) return false;

	const rel = toPosixPath(relative(baseDir, filePath));
	const filePathPosix = toPosixPath(filePath);
	const parent = getSkillParentPaths(filePath, baseDir);

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) return true;
		if (!parent) return false;

		return normalized === parent.rel || normalized === parent.posix;
	});
}

export function isEnabledByOverrides(
	filePath: string,
	patterns: string[],
	baseDir: string,
): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));
	const forceIncludes = overrides
		.filter((pattern) => pattern.startsWith("+"))
		.map((pattern) => pattern.slice(1));
	const forceExcludes = overrides
		.filter((pattern) => pattern.startsWith("-"))
		.map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

export function applyAutoloadDisabledPatterns(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
): Map<string, boolean> {
	const result = new Map<string, boolean>();

	for (const pattern of patterns) {
		const modifier =
			pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!");
		const target = modifier ? pattern.slice(1) : pattern;
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		const exact = pattern.startsWith("+") || pattern.startsWith("-");

		for (const filePath of allPaths) {
			const matches = exact
				? matchesAnyExactPattern(filePath, [target], baseDir)
				: matchesAnyPattern(filePath, [target], baseDir);

			if (matches) result.set(filePath, enabled);
		}
	}

	return result;
}

export function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

export function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readGamaManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

function collectAutoEntries(dir: string, extension: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(extension)) entries.push(fullPath);
		}
	} catch {}

	return entries;
}

export function collectAutoPromptEntries(dir: string): string[] {
	return collectAutoEntries(dir, ".md");
}

export function collectAutoThemeEntries(dir: string): string[] {
	return collectAutoEntries(dir, ".json");
}

export function applyPatterns(
	allPaths: string[],
	patterns: string[],
	baseDir: string,
): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (
				!result.includes(filePath) &&
				matchesAnyExactPattern(filePath, forceIncludes, baseDir)
			) {
				result.push(filePath);
			}
		}
	}

	if (forceExcludes.length > 0) {
		result = result.filter(
			(filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir),
		);
	}

	return new Set(result);
}

export function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {}

	return entries;
}

function collectFilesInternal(
	dir: string,
	filePattern: RegExp,
	skipNodeModules: boolean,
	ignoreMatcher: IgnoreMatcher | undefined,
	rootDir: string | undefined,
	visited: Set<string>,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
				if (isDir && !markDirectoryVisited(fullPath, visited)) continue;
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(
					...collectFilesInternal(fullPath, filePattern, skipNodeModules, ig, root, visited),
				);
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {}

	return files;
}

function collectSkillEntriesInternal(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher: IgnoreMatcher | undefined,
	rootDir: string | undefined,
	visited: Set<string>,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
				if (isDir && !markDirectoryVisited(fullPath, visited)) continue;
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "gama" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntriesInternal(fullPath, mode, ig, root, visited));
		}
	} catch {}

	return entries;
}
