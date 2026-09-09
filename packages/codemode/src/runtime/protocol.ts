import type { CodemodeOutputItem } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";

export interface WorkerData {
	code: string;
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	wasm: CodemodeWasmModule;
	memoryLimitBytes: number | undefined;
	store: Record<string, string>;
	interrupt: SharedArrayBuffer;
}

export type ScriptErrorJson = string;

export interface WorkerCallMessage {
	type: "call";
	id: number;
	target: "tool" | "global";
	name: string;
	args: string | undefined;
}

export type WorkerToHostMessage =
	| WorkerCallMessage
	| { type: "output"; item: CodemodeOutputItem }
	| { type: "done"; ok: true; value: string | undefined; writes: string }
	| { type: "done"; ok: false; error: ScriptErrorJson }
	| { type: "crash"; message: string };

export type HostToWorkerMessage = {
	type: "result";
	id: number;
	ok: boolean;
	payload: string | undefined;
};

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const type = (value as { type?: unknown }).type;
	return type === "call" || type === "output" || type === "done" || type === "crash";
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return (
		typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result"
	);
}
