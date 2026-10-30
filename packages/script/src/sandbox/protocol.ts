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
	| { type: "done"; ok: false; error: string }
	| { type: "crash"; message: string };

export type HostToWorkerMessage = {
	type: "result";
	id: number;
	ok: boolean;
	payload: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOutputItem(value: unknown): value is CodemodeOutputItem {
	if (!isRecord(value)) return false;

	if (value.type === "text") {
		return typeof value.text === "string";
	}

	if (value.type === "image") {
		return typeof value.data === "string" && typeof value.mimeType === "string";
	}

	return false;
}

function isCallMessage(value: Record<string, unknown>): boolean {
	return (
		typeof value.id === "number" &&
		(value.target === "tool" || value.target === "global") &&
		typeof value.name === "string" &&
		isOptionalString(value.args)
	);
}

function isDoneMessage(value: Record<string, unknown>): boolean {
	if (value.ok === true) {
		return isOptionalString(value.value) && typeof value.writes === "string";
	}

	if (value.ok === false) {
		return typeof value.error === "string";
	}

	return false;
}

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (!isRecord(value)) return false;

	switch (value.type) {
		case "call":
			return isCallMessage(value);
		case "output":
			return isOutputItem(value.item);
		case "done":
			return isDoneMessage(value);
		case "crash":
			return typeof value.message === "string";
		default:
			return false;
	}
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return (
		isRecord(value) &&
		value.type === "result" &&
		typeof value.id === "number" &&
		typeof value.ok === "boolean" &&
		isOptionalString(value.payload)
	);
}
