import * as os from "node:os";
import * as path from "node:path";
import type { SourceInfo } from "../core/origin.ts";
import { parseGitUrl } from "../utils/git.ts";
import { getCwdRelativePath } from "../utils/paths.ts";
import { theme } from "./theme/theme.ts";

type ResourceItem = { path: string; sourceInfo?: SourceInfo };
type Scope = "user" | "project" | "path";
type ScopeGroup = {
	scope: Scope;
	paths: ResourceItem[];
	packages: Map<string, ResourceItem[]>;
};

export function formatDisplayPath(fullPath: string, home = os.homedir()): string {
	if (fullPath === home) return "~";
	if (fullPath.startsWith(`${home}/`) || fullPath.startsWith(`${home}\\`)) {
		return `~${fullPath.slice(home.length)}`;
	}
	return fullPath;
}

export function formatExtensionDisplayPath(fullPath: string): string {
	return formatDisplayPath(fullPath).replace(/\/index\.(ts|js)$/, "");
}

export function formatContextPath(target: string, cwd: string): string {
	const absolutePath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
	const relativePath = getCwdRelativePath(absolutePath, path.resolve(cwd));
	return relativePath ?? formatDisplayPath(absolutePath);
}

function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

export function getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
	const normalizedFullPath = fullPath.replace(/\\/g, "/");
	const baseDir = sourceInfo?.baseDir;

	if (baseDir && isPackageSource(sourceInfo)) {
		const normalizedBaseDir = baseDir.replace(/\\/g, "/");
		const npmRoot = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
		if (npmRoot?.[1] && normalizedFullPath.startsWith(`${npmRoot[1]}/`)) {
			return path.posix.relative(normalizedBaseDir, normalizedFullPath);
		}

		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) return npmMatch[2];

	const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) return gitMatch[1];

	return formatDisplayPath(fullPath);
}

function getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	const shortPath = getShortPath(resourcePath, sourceInfo);
	const segments = shortPath
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
	return segments.length > 0 ? segments[segments.length - 1]! : shortPath;
}

function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
	return parseGitUrl(source)?.path || source;
}

function getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	if (!isPackageSource(sourceInfo)) return getCompactPathLabel(resourcePath, sourceInfo);

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) return getCompactPathLabel(resourcePath, sourceInfo);

	const shortPath = getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/")
		? shortPath.slice("extensions/".length)
		: shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "."
			? sourceLabel
			: `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

function getCompactDisplayPathSegments(resourcePath: string): string[] {
	return formatDisplayPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

function getCompactNonPackageExtensionLabel(
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) return getCompactPathLabel(resourcePath);

	for (let count = 1; count <= segments.length; count += 1) {
		const candidate = segments.slice(-count).join("/");
		const unique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) return true;
			return item.segments.slice(-count).join("/") !== candidate;
		});
		if (unique) return candidate;
	}

	return segments.join("/");
}

export function getCompactExtensionLabels(extensions: ResourceItem[]): string[] {
	const local = extensions
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path);
			const last = segments[segments.length - 1];
			if (segments.length > 1 && (last === "index.ts" || last === "index.js")) {
				segments.pop();
			}
			return { path: extension.path, sourceInfo: extension.sourceInfo, segments };
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo));

	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) {
			return getCompactExtensionLabel(extension.path, extension.sourceInfo);
		}

		const index = local.findIndex((item) => item.path === extension.path);
		if (index === -1) return getCompactPathLabel(extension.path, extension.sourceInfo);

		return getCompactNonPackageExtensionLabel(extension.path, index, local);
	});
}

function getDisplaySourceInfo(sourceInfo?: SourceInfo): {
	label: string;
	scopeLabel?: string;
	color: "accent" | "muted";
} {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";

	if (source === "local") {
		if (scope === "user") return { label: "user", color: "muted" };
		if (scope === "project") return { label: "project", color: "muted" };
		if (scope === "temporary") return { label: "path", scopeLabel: "temp", color: "muted" };
		return { label: "path", color: "muted" };
	}

	if (source === "cli") {
		return {
			label: "path",
			scopeLabel: scope === "temporary" ? "temp" : undefined,
			color: "muted",
		};
	}

	const scopeLabel = (
		{ user: "user", project: "project", temporary: "temp" } as Record<string, string>
	)[scope];
	return { label: source, scopeLabel, color: "accent" };
}

function getScopeGroup(sourceInfo?: SourceInfo): Scope {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "cli" || scope === "temporary") return "path";
	if (scope === "user") return "user";
	if (scope === "project") return "project";
	return "path";
}

export function buildScopeGroups(items: ResourceItem[]): ScopeGroup[] {
	const groups: Record<Scope, ScopeGroup> = {
		user: { scope: "user", paths: [], packages: new Map() },
		project: { scope: "project", paths: [], packages: new Map() },
		path: { scope: "path", paths: [], packages: new Map() },
	};

	for (const item of items) {
		const group = groups[getScopeGroup(item.sourceInfo)];
		if (isPackageSource(item.sourceInfo)) {
			const source = item.sourceInfo?.source ?? "local";
			const list = group.packages.get(source) ?? [];
			list.push(item);
			group.packages.set(source, list);
		} else {
			group.paths.push(item);
		}
	}

	return [groups.project, groups.user, groups.path].filter(
		(group) => group.paths.length > 0 || group.packages.size > 0,
	);
}

export function formatScopeGroups(
	groups: ScopeGroup[],
	options: {
		formatPath: (item: ResourceItem) => string;
		formatPackagePath: (item: ResourceItem, source: string) => string;
	},
): string {
	const lines: string[] = [];

	for (const group of groups) {
		lines.push(`  ${theme.fg("accent", group.scope)}`);

		for (const item of [...group.paths].sort((a, b) => a.path.localeCompare(b.path))) {
			lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
		}

		const packages = [...group.packages.entries()].sort(([a], [b]) => a.localeCompare(b));
		for (const [source, items] of packages) {
			lines.push(`    ${theme.fg("mdLink", source)}`);
			for (const item of [...items].sort((a, b) => a.path.localeCompare(b.path))) {
				lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
			}
		}
	}

	return lines.join("\n");
}

export function findSourceInfoForPath(
	target: string,
	sourceInfos: Map<string, SourceInfo>,
): SourceInfo | undefined {
	const exact = sourceInfos.get(target);
	if (exact) return exact;

	let current = target;
	while (current.includes("/")) {
		current = current.substring(0, current.lastIndexOf("/"));
		const parent = sourceInfos.get(current);
		if (parent) return parent;
	}

	return undefined;
}

export function formatPathWithSource(target: string, sourceInfo?: SourceInfo): string {
	if (!sourceInfo) return formatDisplayPath(target);

	const shortPath = getShortPath(target, sourceInfo);
	const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
	const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
	return `${labelText} ${shortPath}`;
}
