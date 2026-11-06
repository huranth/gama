import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface FileReadTracker {
	markRead(path: string, options?: { complete?: boolean }): void;
	markWritten(path: string): void;
	hasRead(path: string): boolean;
	assertRead(path: string): void;
	assertUnchanged(path: string): void;
}

export const READ_BEFORE_CHANGE_MESSAGE =
	"Read before writing. Read this file with the read tool first, then write it again";

export const FILE_CHANGED_SINCE_READ_MESSAGE =
	"This file changed on disk since you last read it, read it again and retry";

type FileVersion = { size: number; mtimeMs: number };

function canonicalKey(filePath: string): string {
	let canonical = filePath;

	try {
		canonical = realpathSync.native(filePath);
	} catch {
		// Not created
	}

	const resolved = resolve(canonical);

	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function currentVersion(filePath: string): FileVersion | undefined {
	try {
		const stats = statSync(filePath);

		return { size: stats.size, mtimeMs: stats.mtimeMs };
	} catch {
		return undefined;
	}
}

function isSameVersion(left: FileVersion, right: FileVersion): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export function createFileReadTracker(): FileReadTracker {
	const known = new Set<string>();
	const complete = new Set<string>();
	const observedVersions = new Map<string, FileVersion>();

	function markKnown(filePath: string, isComplete: boolean): void {
		const key = canonicalKey(filePath);

		known.add(key);
		if (isComplete) complete.add(key);
		else complete.delete(key);

		const version = currentVersion(key);
		if (version === undefined) return;

		observedVersions.set(key, version);
	}

	return {
		markRead(filePath, options) {
			markKnown(filePath, options?.complete !== false);
		},

		markWritten(filePath) {
			markKnown(filePath, true);
		},

		hasRead(filePath) {
			return known.has(canonicalKey(filePath));
		},

		assertRead(filePath) {
			if (complete.has(canonicalKey(filePath))) return;

			throw new Error(READ_BEFORE_CHANGE_MESSAGE);
		},

		assertUnchanged(filePath) {
			const key = canonicalKey(filePath);
			const observed = observedVersions.get(key);
			if (observed === undefined) return;

			const version = currentVersion(key);

			if (version === undefined) {
				throw new Error(`Could not find ${key}, it was deleted since you read it`);
			}

			if (isSameVersion(version, observed)) return;

			throw new Error(`${FILE_CHANGED_SINCE_READ_MESSAGE} in ${key}`);
		},
	};
}
