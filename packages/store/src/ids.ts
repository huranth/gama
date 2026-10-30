import type { Id, Seq } from "./types.ts";

export function idFromNumber<I extends Id<string>>(value: number): I {
	return value as I;
}

export function seqFromNumber(value: number): Seq {
	return value as Seq;
}
