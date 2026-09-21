import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface FileReadTracker {
	markRead(path: string): void;
	markWritten(path: string): void;
	hasRead(path: string): boolean;
	assertRead(path: string): void;
	assertUnchanged(path: string): void;
}

export const READ_BEFORE_CHANGE_MESSAGE =
	"Read before writing. Read this file with the read tool first, then write it again";

export const FILE_CHANGED_SINCE_READ_MESSAGE =
	"This file changed on disk since you last read it, read it again and retry";

function canonicalKey(filePath: string): string {
	let canonical = filePath;
	try {
		canonical = realpathSync.native(filePath);
	} catch {}

	const resolved = resolve(canonical);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function currentVersion(filePath: string): string | undefined {
	try {
		const stats = statSync(filePath);
		return `${stats.size}:${stats.mtimeMs}`;
	} catch {
		return undefined;
	}
}

export function createFileReadTracker(): FileReadTracker {
	const known = new Set<string>();
	const observedVersions = new Map<string, string>();

	const markKnown = (filePath: string): void => {
		const key = canonicalKey(filePath);
		known.add(key);

		const version = currentVersion(key);
		if (version !== undefined) observedVersions.set(key, version);
	};

	return {
		markRead: markKnown,
		markWritten: markKnown,
		hasRead(filePath: string): boolean {
			return known.has(canonicalKey(filePath));
		},
		assertRead(filePath: string): void {
			if (!known.has(canonicalKey(filePath))) {
				throw new Error(READ_BEFORE_CHANGE_MESSAGE);
			}
		},
		assertUnchanged(filePath: string): void {
			const key = canonicalKey(filePath);
			const observed = observedVersions.get(key);
			if (observed === undefined) return;

			const version = currentVersion(key);
			if (version === undefined) {
				throw new Error(`Could not find ${key}, it was deleted since you read it`);
			}

			if (version !== observed) {
				throw new Error(`${FILE_CHANGED_SINCE_READ_MESSAGE} in ${key}`);
			}
		},
	};
}
