import type { CodemodeWasmModule } from "./wasm.ts";

export interface CodemodeToolContext {
	signal: AbortSignal;
}

export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

export interface CodemodeTool {
	name: string;
	description?: string;
	inputSchema?: CodemodeJsonSchema;
	outputSchema?: CodemodeJsonSchema;
	spread?: boolean;
	signature?: string;
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

export type CodemodeOutputItem =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}

export type CodemodeErrorKind = "script" | "timeout" | "aborted" | "sandbox";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
}

export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	delete: string[];
}

export type CodemodeResult =
	| {
			ok: true;
			value: unknown;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			storeWrites: CodemodeStoreWrites;
	  }
	| { ok: false; error: CodemodeError; output: CodemodeOutputItem[]; calls: CodemodeCall[] };

export interface CodemodeSandboxOptions {
	tools?: CodemodeTool[];
	globals?: CodemodeTool[];
	timeoutMs?: number;
	memoryLimitBytes?: number;
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	workerUrl?: string | URL;
}

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	store?: Readonly<Record<string, unknown>>;
}
