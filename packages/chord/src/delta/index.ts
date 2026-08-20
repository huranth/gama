import type { JsonValue } from "../types.ts";

export type { JsonValue } from "../types.ts";

export type Seg = string | number;

export type Path = readonly Seg[];

export type NonEmptyPath = readonly [Seg, ...Seg[]];

export type PathRef<P extends Path = Path> = P | number;

export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]]
	| readonly ["m", Path, number[]];

export type WireOp =
	| readonly ["r", JsonValue]
	| readonly ["s", PathRef<NonEmptyPath>, JsonValue]
	| readonly ["s", JsonValue]
	| readonly ["d", PathRef<NonEmptyPath>]
	| readonly ["d"]
	| readonly ["a", PathRef<NonEmptyPath>, string]
	| readonly ["a", string]
	| readonly ["t", PathRef<NonEmptyPath>, number]
	| readonly ["t", number]
	| readonly ["p", PathRef, number, number, JsonValue[]]
	| readonly ["p", number, number, JsonValue[]]
	| readonly ["m", PathRef, number[]]
	| readonly ["m", number[]]
	| readonly ["#", number, Path];

export type { Draft } from "./draft.ts";

export interface Encoder {
	encode(ops: readonly Op[]): WireOp[];
}

export interface Decoder {
	decode(wire: readonly WireOp[]): Op[];
}

const isObj = (value: unknown): value is object => value !== null && typeof value === "object";

export const isReplace = (op: Op | WireOp): boolean => op[0] === "r";

export const isBase = (ops: readonly (Op | WireOp)[]): boolean =>
	ops.length > 0 && ops[0]![0] === "r";

export function overlap(a: string, b: string, scan: number, probe = 64, maxCandidates = 8): number {
	if (a.length === 0 || b.length === 0 || scan === 0) return 0;
	const tail = a.length > scan ? a.slice(a.length - scan) : a;

	for (const h of [Math.min(probe, b.length), 1]) {
		const head = b.slice(0, h);
		let tried = 0;
		for (let k = tail.indexOf(head); k !== -1; k = tail.indexOf(head, k + 1)) {
			if (++tried > maxCandidates) break;
			const n = tail.length - k;
			if (n <= b.length && tail.slice(k) === b.slice(0, n)) return n;
		}
		if (h === 1) break;
	}
	return 0;
}

export { diffRevisions } from "./diff.ts";
export { type Change, type Prepared, type Tracker, track } from "./tracker.ts";

export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

export class UnsafePathError extends Error {
	readonly segment: Seg;
	constructor(segment: Seg) {
		super(`unsafe path segment: ${String(segment)}`);
		this.segment = segment;
		this.name = "UnsafePathError";
	}
}

export function assertValidOp(op: unknown): asserts op is Op {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	switch (op[0]) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length !== 3) throw new TypeError("s arity");
			assertPathArg(op[1], true);
			return;
		case "d":
			if (op.length !== 2) throw new TypeError("d arity");
			assertPathArg(op[1], true);
			return;
		case "a":
			if (op.length !== 3 || typeof op[2] !== "string") throw new TypeError("a shape");
			assertPathArg(op[1], true);
			return;
		case "t":
			if (op.length !== 3 || !Number.isInteger(op[2]) || op[2] < 0)
				throw new TypeError("t shape");
			assertPathArg(op[1], true);
			return;
		case "p": {
			if (op.length !== 5) throw new TypeError("p arity");
			assertPathArg(op[1]);
			if (!Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("p index");
			if (!Number.isInteger(op[3]) || op[3] < 0) throw new TypeError("p remove");
			if (!Array.isArray(op[4])) throw new TypeError("p items");
			return;
		}
		case "m":
			if (op.length !== 3) throw new TypeError("m arity");
			assertPathArg(op[1]);
			assertPermutation(op[2]);
			return;
		default:
			throw new TypeError(`unknown op verb: ${String(op[0])}`);
	}
}

function assertPathArg(p: unknown, nonEmpty = false): void {
	if (!Array.isArray(p)) throw new TypeError("path is not an array");
	if (nonEmpty && p.length === 0) throw new TypeError("path is empty");
	assertSafePath(p as Path);
}

function assertPermutation(value: unknown): asserts value is number[] {
	if (!Array.isArray(value)) throw new TypeError("m permutation is not an array");
	const seen = new Uint8Array(value.length);
	for (const index of value) {
		if (!Number.isInteger(index) || index < 0 || index >= value.length || seen[index] !== 0) {
			throw new TypeError("m permutation is not a bijection");
		}
		seen[index] = 1;
	}
}

export function assertValidWireOp(op: unknown): asserts op is WireOp {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	const [verb] = op as unknown[];
	const okRef = (r: unknown): void => {
		if (typeof r === "number") {
			if (!Number.isInteger(r) || r < 0) throw new TypeError("bad path id");
			return;
		}
		if (!Array.isArray(r)) throw new TypeError("path is not an array");
		assertSafePath(r as Path);
	};
	switch (verb) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("s arity");
			return;
		case "d":
			if (op.length === 2) okRef(op[1]);
			else if (op.length !== 1) throw new TypeError("d arity");
			return;
		case "a":
			if (op.length === 3) {
				okRef(op[1]);
				if (typeof op[2] !== "string") throw new TypeError("a value");
			} else if (op.length === 2) {
				if (typeof op[1] !== "string") throw new TypeError("a value");
			} else throw new TypeError("a arity");
			return;
		case "t":
			if (op.length === 3) {
				okRef(op[1]);
				if (!Number.isInteger(op[2]) || (op[2] as number) < 0) throw new TypeError("t count");
			} else if (op.length === 2) {
				if (!Number.isInteger(op[1]) || (op[1] as number) < 0) throw new TypeError("t count");
			} else throw new TypeError("t arity");
			return;
		case "p": {
			const [i, r, items] =
				op.length === 5 ? [op[2], op[3], op[4]] : op.length === 4 ? [op[1], op[2], op[3]] : [];
			if (items === undefined) throw new TypeError("p arity");
			if (op.length === 5) okRef(op[1]);
			if (!Number.isInteger(i) || (i as number) < 0) throw new TypeError("p index");
			if (!Number.isInteger(r) || (r as number) < 0) throw new TypeError("p remove");
			if (!Array.isArray(items)) throw new TypeError("p items");
			return;
		}
		case "m":
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("m arity");
			assertPermutation(op[op.length - 1]);
			return;
		case "#": {
			if (
				op.length !== 3 ||
				!Number.isInteger(op[1]) ||
				(op[1] as number) < 0 ||
				!Array.isArray(op[2])
			) {
				throw new TypeError("# shape");
			}
			assertSafePath(op[2] as Path);
			return;
		}
		default:
			throw new TypeError(`unknown op verb: ${String(verb)}`);
	}
}

export function assertSafePath(path: Path): void {
	for (const seg of path) {
		if (typeof seg === "string") {
			if (RESERVED_SEGMENTS.has(seg)) throw new UnsafePathError(seg);
		} else if (!Number.isInteger(seg) || seg < 0) {
			throw new UnsafePathError(seg);
		}
	}
}

function assertIndexInRange(parent: readonly unknown[], index: number): void {
	if (index > parent.length) throw new UnsafePathError(index);
}

export class PathError extends Error {
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyOps(target, ops);
}

function applyOps<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;

	for (const op of ops) {
		assertValidOp(op);
		if (op[0] === "r") {
			root = op[1];
			continue;
		}

		const path = op[1];
		assertSafePath(path);

		if (op[0] === "p") {
			const array = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(array)) throw new PathError(path);
			array.splice(op[2], op[3]);
			const chunkSize = 10_000;
			for (let offset = 0; offset < op[4].length; offset += chunkSize) {
				array.splice(op[2] + offset, 0, ...op[4].slice(offset, offset + chunkSize));
			}
			continue;
		}
		if (op[0] === "m") {
			const array = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(array) || array.length !== op[2].length) throw new PathError(path);
			const previous = array.slice();
			for (let index = 0; index < op[2].length; index++) array[index] = previous[op[2][index]!]!;
			continue;
		}

		const parent = resolve(root, path.slice(0, -1)) as Record<Seg, JsonValue>;
		const key = path[path.length - 1]!;
		if (Array.isArray(parent)) {
			if (typeof key !== "number") throw new UnsafePathError(key);
			assertIndexInRange(parent, key);
		}
		const write = (value: JsonValue) => {
			Object.defineProperty(parent, key, {
				value,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		};
		const read = (): unknown => (Object.hasOwn(parent, key) ? parent[key] : undefined);
		switch (op[0]) {
			case "s":
				write(op[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					(parent as unknown as JsonValue[]).splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(`${current}${op[2]}`);
				break;
			}
			case "t": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(current.slice(op[2]));
				break;
			}
		}
	}
	return root as unknown as T;
}

export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyImmutableBatches(target, [ops]);
}

export function applyImmutableBatches<T>(
	target: T | undefined,
	batches: Iterable<readonly Op[]>,
): T {
	let root = target as unknown as JsonValue;
	const owned = new WeakSet<object>();
	for (const ops of batches) {
		for (const op of ops) {
			assertValidOp(op);
			if (op[0] === "r") {
				root = op[1];
				continue;
			}
			root = copyContainers(
				root,
				op[0] === "p" || op[0] === "m" ? op[1] : op[1].slice(0, -1),
				owned,
			);
			root = applyOps(root, [op]);
		}
	}
	return root as unknown as T;
}

function copyContainers(root: JsonValue, path: Path, owned: WeakSet<object>): JsonValue {
	const copy = (value: JsonValue): JsonValue[] | Record<string, JsonValue> => {
		if (Array.isArray(value)) return value.slice();
		if (!isObj(value)) throw new PathError(path);
		const result = Object.create(
			Object.getPrototypeOf(value) === null ? null : Object.prototype,
		) as Record<string, JsonValue>;
		for (const key of Object.keys(value)) {
			Object.defineProperty(result, key, {
				value: (value as Record<string, JsonValue>)[key],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return result;
	};
	if (!isObj(root)) throw new PathError(path);
	let copiedRoot: JsonValue[] | Record<string, JsonValue>;
	if (owned.has(root)) copiedRoot = root as JsonValue[] | Record<string, JsonValue>;
	else {
		copiedRoot = copy(root);
		owned.add(copiedRoot);
	}
	let destination = copiedRoot;
	for (const segment of path) {
		if (!Object.hasOwn(destination, segment)) throw new PathError(path);
		if (Array.isArray(destination) && typeof segment !== "number")
			throw new UnsafePathError(segment);
		const child = (destination as Record<Seg, JsonValue>)[segment]!;
		if (!isObj(child)) throw new PathError(path);
		if (owned.has(child)) {
			destination = child as JsonValue[] | Record<string, JsonValue>;
			continue;
		}
		const copiedChild = copy(child);
		Object.defineProperty(destination, segment, {
			value: copiedChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		owned.add(copiedChild);
		destination = copiedChild;
	}
	return copiedRoot;
}

function resolveValue(root: JsonValue, path: Path): JsonValue {
	let node: JsonValue = root;
	for (const seg of path) {
		if (!isObj(node)) throw new PathError(path);
		if (Array.isArray(node) && typeof seg !== "number") throw new UnsafePathError(seg);
		if (!Object.hasOwn(node, seg as PropertyKey)) throw new PathError(path);
		node = (node as Record<Seg, JsonValue>)[seg]!;
	}
	return node;
}

function resolve(root: JsonValue, path: Path): JsonValue {
	const node = resolveValue(root, path);
	if (!isObj(node)) throw new PathError(path);
	return node;
}

const pathKey = (path: Path): string => JSON.stringify(path);

export function encoder(): Encoder {
	const seen = new Set<string>();
	const ids = new Map<string, number>();
	let nextId = 0;
	let previous: string | undefined;

	return {
		encode(ops) {
			previous = undefined;
			const out: WireOp[] = [];
			for (const op of ops) {
				if (op[0] === "r") {
					out.push(op);
					seen.clear();
					ids.clear();
					nextId = 0;
					previous = undefined;
					continue;
				}
				const path = op[1];
				const key = pathKey(path);

				if (key === previous) {
					switch (op[0]) {
						case "s":
							out.push(["s", op[2]]);
							break;
						case "d":
							out.push(["d"]);
							break;
						case "a":
							out.push(["a", op[2]]);
							break;
						case "t":
							out.push(["t", op[2]]);
							break;
						case "p":
							out.push(["p", op[2], op[3], op[4]]);
							break;
						case "m":
							out.push(["m", op[2]]);
							break;
					}
					continue;
				}

				let ref: PathRef = path;
				const existing = ids.get(key);
				if (existing !== undefined) {
					ref = existing;
				} else if (seen.has(key)) {
					const id = nextId++;
					ids.set(key, id);
					out.push(["#", id, path]);
					ref = id;
				} else {
					seen.add(key);
				}

				switch (op[0]) {
					case "s":
						out.push(["s", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "d":
						out.push(["d", ref as PathRef<NonEmptyPath>]);
						break;
					case "a":
						out.push(["a", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "t":
						out.push(["t", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "p":
						out.push(["p", ref, op[2], op[3], op[4]]);
						break;
					case "m":
						out.push(["m", ref, op[2]]);
						break;
				}
				previous = key;
			}
			return out;
		},
	};
}

export function decoder(): Decoder {
	const paths = new Map<number, Path>();

	return {
		decode(wire) {
			let previous: Path | undefined;
			const out: Op[] = [];
			for (const op of wire) {
				assertValidWireOp(op);
				if (op[0] === "#") {
					assertSafePath(op[2]);
					paths.set(op[1], op[2]);
					continue;
				}
				if (op[0] === "r") {
					out.push(op);
					paths.clear();
					previous = undefined;
					continue;
				}

				const short =
					(op[0] === "d" && op.length === 1) ||
					(op[0] !== "d" && op[0] !== "p" && op.length === 2) ||
					(op[0] === "p" && op.length === 4);

				let path: Path;
				if (short) {
					if (previous === undefined) throw new PathError([]);
					path = previous;
				} else {
					const ref = op[1] as PathRef;
					if (typeof ref === "number") {
						const resolved = paths.get(ref);
						if (resolved === undefined) throw new PathError(ref);
						path = resolved;
					} else {
						path = ref;
					}
					previous = path;
				}

				if (op[0] !== "p" && op[0] !== "m" && path.length === 0) throw new PathError(path);
				switch (op[0]) {
					case "s":
						out.push(["s", path as NonEmptyPath, (short ? op[1] : op[2]) as JsonValue]);
						break;
					case "d":
						out.push(["d", path as NonEmptyPath]);
						break;
					case "a":
						out.push(["a", path as NonEmptyPath, (short ? op[1] : op[2]) as string]);
						break;
					case "t":
						out.push(["t", path as NonEmptyPath, (short ? op[1] : op[2]) as number]);
						break;
					case "p": {
						const [i, r, items] = short
							? [op[1] as number, op[2] as number, op[3] as JsonValue[]]
							: [op[2] as number, op[3] as number, op[4] as JsonValue[]];
						out.push(["p", path, i, r, items]);
						break;
					}
					case "m":
						out.push(["m", path, (short ? op[1] : op[2]) as number[]]);
						break;
				}
			}
			return out;
		},
	};
}
