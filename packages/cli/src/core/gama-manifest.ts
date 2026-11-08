import { readFileSync, statSync } from "node:fs";
import { isRecord } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

export interface GamaManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

// Path guard
function isSafeManifestEntry(entry: string): boolean {
	const candidate = entry.replace(/^[!+-]/, "").replace(/\\/g, "/");
	if (!candidate || candidate.includes("\0")) return false;
	if (candidate.startsWith("/") || /^[a-zA-Z]:/.test(candidate)) return false;
	return !candidate.split("/").some((segment) => segment === "..");
}

export function readGamaManifest(packageJsonPath: string): GamaManifest | null {
	try {
		if (statSync(packageJsonPath).size > MAX_MANIFEST_BYTES) return null;
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isRecord(pkg) || !isRecord(pkg.gama)) {
			return null;
		}

		const manifest: GamaManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.gama[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				const safeEntries = entries.filter(isSafeManifestEntry);
				if (safeEntries.length > 0) manifest[field] = safeEntries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
