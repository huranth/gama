import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export type CodemodeWasmModule = object;

interface WebAssemblyGlobal {
	compile(bytes: Uint8Array): Promise<CodemodeWasmModule>;
}

const modules = new Map<string, Promise<CodemodeWasmModule>>();

export function loadQuickJSWasm(path?: string): Promise<CodemodeWasmModule> {
	const resolved = path ?? createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
	let module = modules.get(resolved);

	if (!module) {
		const { WebAssembly } = globalThis as unknown as { WebAssembly: WebAssemblyGlobal };

		module = readFile(resolved)
			.then((bytes) => WebAssembly.compile(bytes))
			.catch((error: unknown) => {
				modules.delete(resolved);
				throw error;
			});
		modules.set(resolved, module);
	}

	return module;
}
