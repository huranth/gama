import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PruneTempFilesOptions {
	prefix: string;
	maxAgeMs: number;
	folder?: string;
	isTarget?: (name: string) => boolean;
}

function isExpired(path: string, now: number, maxAgeMs: number): boolean {
	try {
		return now - statSync(path).mtimeMs > maxAgeMs;
	} catch {
		return false;
	}
}

export function pruneTempFiles(options: PruneTempFilesOptions): void {
	const { prefix, maxAgeMs, folder = tmpdir(), isTarget } = options;
	if (!prefix || maxAgeMs <= 0) return;

	const now = Date.now();
	try {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
			if (isTarget && !isTarget(entry.name)) continue;

			const path = join(folder, entry.name);
			try {
				if (isExpired(path, now, maxAgeMs)) rmSync(path, { force: true });
			} catch {}
		}
	} catch {}
}
