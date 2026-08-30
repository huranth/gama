import type { ProviderEnv } from "../types.ts";

let procEnvCache: Map<string, string> | null = null;

export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return (
		env?.[name] ||
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		getBunSandboxEnvValue(name) ||
		undefined
	);
}

function getBunSandboxEnvValue(name: string): string | undefined {
	if (typeof process === "undefined" || !process.versions?.bun) {
		return undefined;
	}

	const envIsEmpty = Object.keys(process.env).length === 0;
	if (!envIsEmpty) {
		return undefined;
	}

	if (procEnvCache === null) {
		procEnvCache = new Map();
		try {
			const { readFileSync } = require("node:fs") as {
				readFileSync(path: string, encoding: BufferEncoding): string;
			};
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// Unreadable environ
		}
	}

	return procEnvCache.get(name);
}
