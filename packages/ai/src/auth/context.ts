import type { AuthContext } from "./types.ts";

export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const value = getProcessEnv()?.[name];

			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		},

		async fileExists(path: string): Promise<boolean> {
			try {
				const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
				const resolved = await resolveHome(path);

				await fs.access(resolved);

				return true;
			} catch {
				return false;
			}
		},
	};
}

interface NodeFsModule {
	access(path: string): Promise<void>;
}

interface NodeOsModule {
	homedir(): string;
}

const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

function getProcessEnv(): Record<string, string | undefined> | undefined {
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return proc?.env;
}

async function resolveHome(path: string): Promise<string> {
	if (!path.startsWith("~")) return path;

	const os = (await importNodeModule("node:os")) as NodeOsModule;

	return os.homedir() + path.slice(1);
}
