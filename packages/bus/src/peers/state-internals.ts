import type { Op } from "../patch/index.ts";
import type { Context } from "../types.ts";

export interface ReplicatedStateInternals {
	snapshot(): { readonly value: unknown; readonly sequence: number };
	subscribe(
		listener: (ops: readonly Op[], sequence: number, context: Context) => void,
	): () => void;
}

type InternalsGlobal = {
	__gamaChordStateInternals?: WeakMap<object, ReplicatedStateInternals>;
};

const globalStore = globalThis as InternalsGlobal;

const sources =
	globalStore.__gamaChordStateInternals ?? new WeakMap<object, ReplicatedStateInternals>();
globalStore.__gamaChordStateInternals = sources;

export function registerReplicatedStateInternals(
	value: object,
	internals: ReplicatedStateInternals,
): void {
	sources.set(value, internals);
}

export function getReplicatedStateInternals(value: unknown): ReplicatedStateInternals | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return sources.get(value);
}
