import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

export interface PathInputOptions {
	trim?: boolean;
	expandTilde?: boolean;
	homeDir?: string;
	stripAtPrefix?: boolean;
	normalizeUnicodeSpaces?: boolean;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const WINDOWS_SHELL_PATH = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

const REMOTE_PATH_PREFIXES = ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"];

const CLOUD_SYNC_ATTRIBUTES: Record<string, string[]> = {
	darwin: ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"],
	linux: ["user.com.dropbox.ignored"],
};

export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function getFileRevision(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return undefined;
	}
}

export function resolvePath(
	input: string,
	baseDir: string = process.cwd(),
	options: PathInputOptions = {},
): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	if (isAbsolute(normalized)) {
		return nodeResolvePath(normalized);
	}

	return nodeResolvePath(normalizedBaseDir, normalized);
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	const relativePath = getCwdRelativePath(absolutePath, cwd) ?? absolutePath;
	return relativePath.split(sep).join("/");
}

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}

export function markPathIgnoredByCloudSync(path: string): void {
	const attrs = CLOUD_SYNC_ATTRIBUTES[process.platform] ?? [];
	for (const attr of attrs) {
		if (process.platform === "darwin") {
			spawnProcessSync("xattr", ["-w", attr, "1", path], {
				encoding: "utf-8",
				stdio: "ignore",
			});
			continue;
		}

		spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], {
			encoding: "utf-8",
			stdio: "ignore",
		});
	}
}

export function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
		return filePath;
	}

	const match = filePath.match(WINDOWS_SHELL_PATH);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	const isRemote = REMOTE_PATH_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
	return !isRemote;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}

	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}

	if (process.platform === "win32") {
		normalized = normalizeWindowsShellPath(normalized);
	}

	if (options.expandTilde ?? true) {
		normalized = expandHome(normalized, options.homeDir ?? homedir());
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	const isHomePrefix =
		path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"));
	if (!isHomePrefix) return path;
	return join(home, path.slice(2));
}
