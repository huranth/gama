import type { PathMetadata } from "./pkg/types.ts";

export type SourceScope = "user" | "project" | "temporary";

export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

export const BUILTIN_PATH_PREFIX = "builtin:";

export function isSyntheticPath(path: string): boolean {
	return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}

// Reads kind
function syntheticSource(path: string): string | undefined {
	if (path.startsWith(BUILTIN_PATH_PREFIX)) return "builtin";
	if (!isSyntheticPath(path)) return undefined;

	const inner = path.slice(1, -1);
	return inner.split(":")[0] || "temporary";
}

export function getSyntheticPathSource(path: string): string | undefined {
	return syntheticSource(path);
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
