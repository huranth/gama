import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
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

const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const homePrefixLength = 2;

const atPrefix = "@";

const windowsShellPath = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

const remotePathPrefixes = ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"];

const cloudSyncAttributes: Record<string, string[]> = {
	darwin: ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"],
	linux: ["user.com.dropbox.ignored"],
};

export function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	const isRemote = remotePathPrefixes.some((prefix) => trimmed.startsWith(prefix));
	return !isRemote;
}

export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;

	const isHomePrefix =
		path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"));
	if (!isHomePrefix) return path;

	return join(home, path.slice(homePrefixLength));
}

export function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
		return filePath;
	}

	const match = filePath.match(windowsShellPath);
	if (!match) return filePath;

	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;

	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(unicodeSpaces, " ");
	}

	if (options.stripAtPrefix && normalized.startsWith(atPrefix)) {
		normalized = normalized.slice(atPrefix.length);
	}

	if (process.platform === "win32") {
		normalized = normalizeWindowsShellPath(normalized);
	}

	if (options.expandTilde ?? true) {
		normalized = expandHome(normalized, options.homeDir ?? homedir());
	}

	if (normalized.startsWith("file://")) {
		return fileURLToPath(normalized);
	}

	return normalized;
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

export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);

	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	return isInsideCwd ? relativePath || "." : undefined;
}

export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	const relativePath = getCwdRelativePath(absolutePath, cwd) ?? absolutePath;

	return toPosixPath(relativePath);
}

export function getFileRevision(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
		const parts = [
			stats.dev,
			stats.ino,
			stats.size,
			stats.mtimeNs,
			stats.ctimeNs,
			stats.birthtimeNs,
			digest,
		];

		return parts.join(":");
	} catch {
		return undefined;
	}
}

function attributeCommand(attr: string, path: string): [string, string[]] {
	if (process.platform === "darwin") {
		return ["xattr", ["-w", attr, "1", path]];
	}

	return ["setfattr", ["-n", attr, "-v", "1", path]];
}

export function markPathIgnoredByCloudSync(path: string): void {
	const attrs = cloudSyncAttributes[process.platform] ?? [];

	for (const attr of attrs) {
		const [command, args] = attributeCommand(attr, path);
		spawnProcessSync(command, args, { encoding: "utf-8", stdio: "ignore" });
	}
}
