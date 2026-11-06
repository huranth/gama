import { accessSync, constants, statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

const narrowSpace = "\u202F";

const curlyQuote = "\u2019";

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

async function pathIsFile(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

// Mac filenames
function tryScreenshotVariant(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${narrowSpace}$1.`);
}

// Nfd names
function tryNfdVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

// Curly quotes
function tryCurlyVariant(filePath: string): string {
	return filePath.replace(/'/g, curlyQuote);
}

function pathVariants(base: string): string[] {
	const nfd = tryNfdVariant(base);
	const variants = [
		base,
		tryScreenshotVariant(base),
		nfd,
		tryCurlyVariant(base),
		tryCurlyVariant(nfd),
	];

	return [...new Set(variants)];
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	return pathVariants(resolved).find(fileExists) ?? resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	for (const variant of pathVariants(resolved)) {
		if (await pathIsFile(variant)) return variant;
	}

	return resolved;
}
