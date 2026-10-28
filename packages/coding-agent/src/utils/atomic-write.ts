import { chmodSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Write a file via a temp file in the same directory plus rename, so a crash
 * mid-write never leaves a truncated target. Symlinked targets are written
 * through. An existing file keeps its mode; `mode` applies to new files.
 */
export function writeFileAtomicSync(path: string, data: string, mode?: number): void {
	let target = path;
	let existingMode: number | undefined;
	try {
		target = realpathSync(path);
		existingMode = statSync(target).mode & 0o777;
	} catch {}

	const tempPath = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
	const fileMode = existingMode ?? mode;

	try {
		writeFileSync(tempPath, data, { encoding: "utf-8", flag: "wx", mode: fileMode });
		// writeFileSync mode is masked by umask; make it exact.
		if (fileMode !== undefined) chmodSync(tempPath, fileMode);
		renameSync(tempPath, target);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {}
		throw error;
	}
}
