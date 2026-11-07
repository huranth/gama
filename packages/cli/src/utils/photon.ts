import type { PathOrFileDescriptor } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type ReadFileSync = typeof fs.readFileSync;

const require = createRequire(import.meta.url);

const fs = require("fs") as typeof import("fs");

const wasmFilename = "photon_rs_bg.wasm";

let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;

let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

function pathOrNull(file: PathOrFileDescriptor): string | null {
	if (typeof file === "string") {
		return file;
	}

	if (file instanceof URL) {
		return fileURLToPath(file);
	}

	return null;
}

function getFallbackWasmPaths(): string[] {
	const execDir = path.dirname(process.execPath);

	return [
		path.join(execDir, wasmFilename),
		path.join(execDir, "photon", wasmFilename),
		path.join(process.cwd(), wasmFilename),
	];
}

function setReadFileSync(replacement: ReadFileSync): void {
	const mutableFs = fs as { readFileSync: ReadFileSync };

	try {
		mutableFs.readFileSync = replacement;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: replacement,
			writable: true,
			configurable: true,
		});
	}
}

export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	if (photonModule) {
		return photonModule;
	}

	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		const restoreReadFileSync = patchPhotonWasmRead();

		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			photonModule = null;
			return photonModule;
		} finally {
			restoreReadFileSync();
		}
	})();

	return loadPromise;
}

function readFallback(
	originalReadFileSync: ReadFileSync,
	fallbackPaths: string[],
	options: Parameters<ReadFileSync>[1],
): Buffer | string | undefined {
	for (const fallbackPath of fallbackPaths) {
		if (!fs.existsSync(fallbackPath)) {
			continue;
		}

		if (options === undefined) {
			return originalReadFileSync(fallbackPath);
		}

		return originalReadFileSync(fallbackPath, options);
	}

	return undefined;
}

function patchPhotonWasmRead(): () => void {
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	const fallbackPaths = getFallbackWasmPaths();

	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		const [file, options] = args;
		const resolvedPath = pathOrNull(file);

		if (!resolvedPath?.endsWith(wasmFilename)) {
			return originalReadFileSync(...args);
		}

		try {
			return originalReadFileSync(...args);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			const isMissing = !err?.code || err.code === "ENOENT";
			if (!isMissing) {
				throw error;
			}

			const fallback = readFallback(originalReadFileSync, fallbackPaths, options);
			if (fallback === undefined) {
				throw error;
			}

			return fallback;
		}
	}) as ReadFileSync;

	setReadFileSync(patchedReadFileSync);
	return () => setReadFileSync(originalReadFileSync);
}
