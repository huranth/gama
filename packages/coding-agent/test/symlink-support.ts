import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function probeFileSymlinks(): boolean {
	const dir = mkdtempSync(join(tmpdir(), "gama-symlink-probe-"));
	try {
		const target = join(dir, "target");
		writeFileSync(target, "");
		symlinkSync(target, join(dir, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export const canCreateFileSymlinks = probeFileSymlinks();
