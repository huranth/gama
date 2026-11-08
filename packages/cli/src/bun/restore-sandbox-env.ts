import { readFileSync } from "node:fs";

export function restoreSandboxEnv(): void {
	if (!process.versions?.bun) return;

	if (Object.keys(process.env).length > 0) return;

	try {
		const data = readFileSync("/proc/self/environ", "utf-8");

		for (const entry of data.split("\0")) {
			const separator = entry.indexOf("=");
			if (separator > 0) {
				process.env[entry.slice(0, separator)] = entry.slice(separator + 1);
			}
		}
	} catch {
		// Unreadable
	}
}
