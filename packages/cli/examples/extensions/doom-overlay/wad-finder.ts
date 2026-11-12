import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_WAD = join(__dirname, "doom1.wad");
const USER_WAD = join(homedir(), ".doom", "doom1.wad");
const WAD_URL = "https://www.gamers.org/pub/idgames/idstuff/doom/doom-1.8.wad.gz";

const DEFAULT_WAD_PATHS = ["./doom1.wad", "./DOOM1.WAD", "~/doom1.wad", "~/.doom/doom1.wad"];

function expandHome(path: string): string {
	return resolve(path.replace(/^~/, homedir()));
}

export function findWadFile(customPath?: string): string | null {
	if (customPath) {
		const resolved = expandHome(customPath);
		if (existsSync(resolved)) return resolved;
		return null;
	}

	if (existsSync(BUNDLED_WAD)) {
		return BUNDLED_WAD;
	}

	for (const p of DEFAULT_WAD_PATHS) {
		const resolved = expandHome(p);
		if (existsSync(resolved)) return resolved;
	}

	return null;
}

export async function ensureWadFile(): Promise<string | null> {
	const existing = findWadFile();
	if (existing) return existing;

	try {
		const response = await fetch(WAD_URL, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const wad = gunzipSync(Buffer.from(await response.arrayBuffer()));
		if (wad.subarray(0, 4).toString("ascii") !== "IWAD") {
			throw new Error("Downloaded file is not a valid IWAD");
		}
		try {
			writeFileSync(BUNDLED_WAD, wad);
			return BUNDLED_WAD;
		} catch {
			mkdirSync(dirname(USER_WAD), { recursive: true });
			writeFileSync(USER_WAD, wad);
			return USER_WAD;
		}
	} catch {
		return null;
	}
}
