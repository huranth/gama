import path from "node:path";
import { existsSync, readFileSync } from "fs";

export { getChangelogPath } from "../config.ts";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

const GITHUB_REPO = "huranth/gama";
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;
const CHANGELOG_HOSTS = ["https://unpkg.com", "https://cdn.jsdelivr.net/npm"];

function entryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

export function normalizeChangelogLinks(
	markdown: string,
	version: string | ChangelogEntry,
): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
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

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
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

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	const repoUrl = `https://github.com/${GITHUB_REPO}`;
	let canonicalTarget = target;

	// Floating refs
	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (!canonicalTarget.startsWith(floatingRefPrefix)) continue;

			const suffix = canonicalTarget.slice(floatingRefPrefix.length);
			canonicalTarget = `${repoUrl}/${route}/${tag}/${suffix}`;
		}
	}

	const isAbsolute =
		canonicalTarget.startsWith("#") ||
		canonicalTarget.startsWith("//") ||
		URL_SCHEME_RE.test(canonicalTarget);
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

export function parseChangelogContent(content: string): ChangelogEntry[] {
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];

	let currentLines: string[] = [];
	let currentVersion: { major: number; minor: number; patch: number } | null = null;

	for (const line of lines) {
		if (line.startsWith("## ")) {
			const previous = currentVersion;

			if (previous && currentLines.length > 0) {
				entries.push({
					...previous,
					content: currentLines.join("\n").trim(),
				});
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
		} else if (currentVersion) {
			currentLines.push(line);
		}
	}

	if (currentVersion && currentLines.length > 0) {
		entries.push({
			...currentVersion,
			content: currentLines.join("\n").trim(),
		});
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
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

export function findChangelogEntry(
	entries: ChangelogEntry[],
	version: string,
): ChangelogEntry | undefined {
	const [major, minor, patch] = version
		.trim()
		.replace(/^v/, "")
		.split("-")[0]
		.split(".")
		.map(Number);
	if (![major, minor, patch].every(Number.isInteger)) {
		return undefined;
	}

	return entries.find(
		(entry) => entry.major === major && entry.minor === minor && entry.patch === patch,
	);
}

export async function fetchChangelogForVersion(
	packageName: string,
	version: string,
	timeoutMs = 5000,
): Promise<string | undefined> {
	if (process.env.GAMA_OFFLINE) return undefined;

	for (const host of CHANGELOG_HOSTS) {
		try {
			const response = await fetch(`${host}/${packageName}@${version}/CHANGELOG.md`, {
				headers: { accept: "text/plain" },
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) continue;

			const entry = findChangelogEntry(parseChangelogContent(await response.text()), version);
			if (entry) return entry.content;
		} catch {}
	}

	return undefined;
}
