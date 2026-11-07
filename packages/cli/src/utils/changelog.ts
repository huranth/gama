import path from "node:path";
import { existsSync, readFileSync } from "fs";

export { getChangelogPath } from "../config.ts";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

interface ChangelogVersion {
	major: number;
	minor: number;
	patch: number;
}

const githubRepo = "huranth/gama";

const changelogBasePath = "packages/cli";

const schemePattern = /^[a-z][a-z0-9+.-]*:/i;

const inlineLinkPattern = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

const changelogHosts = ["https://unpkg.com", "https://cdn.jsdelivr.net/npm"];

const floatingRefRoutes = ["blob", "tree"];

const floatingRefBranches = ["main", "master"];

const defaultTimeoutMs = 5000;

function entryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function parseVersion(version: string): [number, number, number] | undefined {
	const core = version.trim().replace(/^v/, "").split("-")[0]!;
	const parts = core.split(".");

	// Exact version
	if (parts.length !== 3) return undefined;

	const [major, minor, patch] = parts.map(Number);
	if (![major, minor, patch].every(Number.isInteger)) return undefined;

	return [major!, minor!, patch!];
}

function buildEntry(version: ChangelogVersion, lines: string[]): ChangelogEntry {
	return { ...version, content: lines.join("\n").trim() };
}

export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;

	return v1.patch - v2.patch;
}

export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

export function findChangelogEntry(
	entries: ChangelogEntry[],
	version: string,
): ChangelogEntry | undefined {
	const parsed = parseVersion(version);
	if (!parsed) return undefined;

	const [major, minor, patch] = parsed;
	return entries.find(
		(entry) => entry.major === major && entry.minor === minor && entry.patch === patch,
	);
}

function toPosixSlashes(value: string): string {
	return value.replaceAll("\\", "/");
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function isDirectoryTarget(targetPath: string, repositoryPath: string): boolean {
	if (targetPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = toPosixSlashes(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(changelogBasePath, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function pinFloatingRef(target: string, tag: string): string {
	const repoUrl = `https://github.com/${githubRepo}`;
	let canonicalTarget = target;

	for (const route of floatingRefRoutes) {
		for (const branch of floatingRefBranches) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (!canonicalTarget.startsWith(floatingRefPrefix)) continue;

			const suffix = canonicalTarget.slice(floatingRefPrefix.length);
			canonicalTarget = `${repoUrl}/${route}/${tag}/${suffix}`;
		}
	}

	return canonicalTarget;
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	const canonicalTarget = pinFloatingRef(target, tag);
	const repoUrl = `https://github.com/${githubRepo}`;

	const isAbsolute =
		canonicalTarget.startsWith("#") ||
		canonicalTarget.startsWith("//") ||
		schemePattern.test(canonicalTarget);
	if (isAbsolute) return canonicalTarget;

	// Local links
	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) return canonicalTarget;

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) return canonicalTarget;

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	const encodedPath = encodeURI(repositoryPath);

	return `${repoUrl}/${route}/${tag}/${encodedPath}${query}${fragment}`;
}

export function normalizeChangelogLinks(
	markdown: string,
	version: string | ChangelogEntry,
): string {
	const tag = normalizeTag(version);

	return markdown.replace(inlineLinkPattern, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

export function parseChangelogContent(content: string): ChangelogEntry[] {
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];

	let currentLines: string[] = [];
	let currentVersion: ChangelogVersion | null = null;

	for (const line of lines) {
		if (!line.startsWith("## ")) {
			if (currentVersion) currentLines.push(line);
			continue;
		}

		const previous = currentVersion;
		if (previous && currentLines.length > 0) {
			entries.push(buildEntry(previous, currentLines));
		}

		const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
		if (!versionMatch) {
			currentVersion = null;
			currentLines = [];
			continue;
		}

		currentVersion = {
			major: Number.parseInt(versionMatch[1], 10),
			minor: Number.parseInt(versionMatch[2], 10),
			patch: Number.parseInt(versionMatch[3], 10),
		};
		currentLines = [line];
	}

	if (currentVersion && currentLines.length > 0) {
		entries.push(buildEntry(currentVersion, currentLines));
	}

	return entries;
}

export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		return parseChangelogContent(readFileSync(changelogPath, "utf-8"));
	} catch (error) {
		console.error(`Changelog failed: ${error}`);
		return [];
	}
}

export async function fetchChangelogForVersion(
	packageName: string,
	version: string,
	timeoutMs = defaultTimeoutMs,
): Promise<string | undefined> {
	if (process.env.GAMA_OFFLINE) return undefined;

	for (const host of changelogHosts) {
		try {
			const response = await fetch(`${host}/${packageName}@${version}/CHANGELOG.md`, {
				headers: { accept: "text/plain" },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				await response.body?.cancel();
				continue;
			}

			const entry = findChangelogEntry(parseChangelogContent(await response.text()), version);
			if (entry) return entry.content;
		} catch {}
	}

	return undefined;
}
