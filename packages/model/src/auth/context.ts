import type { AuthContext } from "./types.ts";

interface NodeFsModule {
	stat(path: string): Promise<{ isFile(): boolean }>;
}

interface NodeOsModule {
	homedir(): string;
}

const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

function isHome(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

function getProcessEnv(): Record<string, string | undefined> | undefined {
	const globalProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process;

	return globalProcess?.env;
}

async function resolveHome(path: string): Promise<string> {
	if (!isHome(path)) return path;

	const os = (await importNodeModule("node:os")) as NodeOsModule;

	return os.homedir() + path.slice(1);
}

export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const value = getProcessEnv()?.[name];
			const trimmed = typeof value === "string" ? value.trim() : "";

			return trimmed.length > 0 ? trimmed : undefined;
		},

		async fileExists(path: string): Promise<boolean> {
			try {
				const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
				const resolved = await resolveHome(path);

				const stats = await fs.stat(resolved);

				return stats.isFile();
			} catch {
				return false;
			}
		},
	};
}
