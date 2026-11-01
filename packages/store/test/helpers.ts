import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDirs() {
	const directories = new Set<string>();

	async function sqlitePath(label: string): Promise<string> {
		const prefix = `gama-durable-${label}-`;
		const directory = await mkdtemp(join(tmpdir(), prefix));
		directories.add(directory);
		return join(directory, "session.sqlite");
	}

	async function cleanup(): Promise<void> {
		for (const directory of directories) {
			await rm(directory, { recursive: true, force: true });
		}
		directories.clear();
	}

	return { sqlitePath, cleanup };
}
