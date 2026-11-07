import { randomUUID } from "node:crypto";
import { chmodSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const permissionMask = 0o777;

const privateMode = 0o600;

function resolveWriteTarget(path: string): { target: string; mode?: number } {
	try {
		const target = realpathSync(path);
		return { target, mode: statSync(target).mode & permissionMask };
	} catch {
		return { target: path };
	}
}

export function writeFileAtomicSync(path: string, data: string, mode?: number): void {
	const { target, mode: existingMode } = resolveWriteTarget(path);
	const fileMode = mode ?? existingMode;
	const isWindows = process.platform === "win32";
	const suffix = `${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
	const tempPath = join(dirname(target), `.${basename(target)}.${suffix}.tmp`);

	try {
		writeFileSync(tempPath, data, { encoding: "utf-8", flag: "wx", mode: fileMode });
		if (fileMode !== undefined && !isWindows) chmodSync(tempPath, fileMode);

		renameSync(tempPath, target);
		// Windows only
		if (fileMode !== undefined && isWindows) chmodSync(target, fileMode);
	} catch (error) {
		if (isWindows) {
			try {
				chmodSync(tempPath, privateMode);
			} catch {}
		}

		try {
			unlinkSync(tempPath);
		} catch {}

		throw error;
	}
}
