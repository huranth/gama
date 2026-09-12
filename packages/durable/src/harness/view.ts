import {
	type AttachedReplicatedState,
	type Context,
	type JsonValue,
	replicatedState,
} from "@huranth/chord";
import { withoutAbortSignal } from "@huranth/chord/context";
import { applyImmutable, type NonEmptyPath, type Op, type Path } from "@huranth/chord/delta";
import { CommittedStateSource, CommittedWatch } from "../session/observation.ts";
import type { SessionImpl } from "../session/session.ts";
import type {
	CommitPublication,
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	DocumentId,
	EntryRecord,
	JsonObject,
	Storage,
	WatchHandle,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { activeEntries, captureContextBounds } from "./context.ts";
import { InboxDoc } from "./inbox.ts";
import { LiveDoc } from "./live.ts";
import { UsageDoc } from "./usage.ts";
import { closedError } from "./util.ts";

export type ConversationView = {
	readonly conversation: ConversationRecord;
	readonly entries: readonly EntryRecord[];
	readonly docs: Readonly<Record<string, JsonObject>>;
};

export type ViewObserver = {
	advance?(value: ConversationView, ops: readonly Op[], context: Context): void;
	publication?(
		before: ConversationView,
		after: ConversationView,
		ops: readonly Op[],
		publication: CommitPublication,
		context: Context,
	): void;
	closeSession(): void;
};

type Mount = {
	value: ConversationView;
	readonly docs: Map<string, { id: DocumentId; version: number }>;
	readonly observers: Set<ViewObserver>;
};

const MOUNTED = [
	AgentDoc,
	LiveDoc,
	InboxDoc,
	UsageDoc,
] as unknown as readonly ConversationDocToken<JsonObject>[];
const MOUNTED_KINDS: ReadonlySet<string> = new Set(MOUNTED.map((token) => token.definition.kind));

const VIEWS = new WeakMap<object, ConversationViews>();

function prefixed(op: Op, prefix: NonEmptyPath): Op {
	const at = (path: Path): NonEmptyPath => [...prefix, ...path] as unknown as NonEmptyPath;
	switch (op[0]) {
		case "r":
			return ["s", prefix, op[1]];
		case "p":
			return ["p", at(op[1]), op[2], op[3], op[4]];
		case "m":
			return ["m", at(op[1]), op[2]];
		case "s":
			return ["s", at(op[1]), op[2]];
		case "d":
			return ["d", at(op[1])];
		case "a":
			return ["a", at(op[1]), op[2]];
		case "t":
			return ["t", at(op[1]), op[2]];
	}
}

function advance(
	id: ConversationId,
	mount: Mount,
	publication: CommitPublication,
	context: Context,
): void {
	const docOps: Op[] = [];
	const entryOps: Op[] = [];
	let entries = mount.value.entries;
	for (const change of publication.changes) {
		if (change.type === "entry" && change.value.conversationId === id) {
			const entry = change.value;
			const value = entry as unknown as JsonValue;
			if (entry.head === undefined) {
				entryOps.push(["p", ["entries"], entries.length, 0, [value]]);
				entries = [...entries, entry];
				continue;
			}
			const target = entry.head;
			let kept = entries.findIndex(
				(candidate) => candidate.head === undefined && candidate.id >= target,
			);
			if (kept < 0) kept = entries.length;
			entryOps.push(["p", ["entries"], 0, kept, [value]]);
			entries = [entry, ...entries.slice(kept)];
			continue;
		}
		if (change.type !== "document" || change.conversationId !== id) continue;
		const kind = change.record.kind;
		if (!MOUNTED_KINDS.has(kind) || change.record.key !== undefined) continue;
		const path: NonEmptyPath = ["docs", kind];
		const mounted = mount.docs.get(kind);
		if (change.value === null) {
			if (mounted?.id !== change.record.id) continue;
			mount.docs.delete(kind);
			docOps.push(["d", path]);
		} else if (mounted?.id === change.record.id && mounted.version === change.version) {
			for (const op of change.ops) {
				docOps.push(prefixed(op, path));
			}
		} else {
			mount.docs.set(kind, { id: change.record.id, version: change.version! });
			docOps.push(["s", path, change.value]);
		}
	}
	const before = mount.value;
	const ops = [...docOps, ...entryOps];
	const frameContext = withoutAbortSignal(context);

	if (ops.length > 0) {
		const value = docOps.length === 0 ? mount.value : applyImmutable(mount.value, docOps);
		mount.value = entries === value.entries ? value : { ...value, entries };

		for (const observer of [...mount.observers]) {
			observer.advance?.(mount.value, ops, frameContext);
		}
	}
	for (const observer of [...mount.observers]) {
		observer.publication?.(before, mount.value, ops, publication, frameContext);
	}
}

export class ConversationViews {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #mounts = new Map<ConversationId, Mount>();
	#closed = false;

	constructor(session: SessionImpl, storage: Storage) {
		this.#session = session;
		this.#storage = storage;
		VIEWS.set(session, this);
		session.subscribeCommits((publication, context) => {
			for (const [id, mount] of this.#mounts) {
				advance(id, mount, publication, context);
			}
		});
		session.subscribeClose(() => {
			this.#closed = true;
			for (const mount of this.#mounts.values()) {
				for (const observer of [...mount.observers]) {
					observer.closeSession();
				}
			}
			this.#mounts.clear();
		});
	}

	async state(
		id: ConversationId,
		context: Context,
	): Promise<AttachedReplicatedState<ConversationView>> {
		const { observer, detach } = await this.attach(
			id,
			(value, release) => new CommittedStateSource<ConversationView>(value, release),
			context,
		);
		try {
			return replicatedState(observer);
		} catch (error) {
			detach();
			throw error;
		}
	}

	async watch(id: ConversationId, context: Context): Promise<WatchHandle<ConversationView>> {
		const { observer } = await this.attach(
			id,
			(value, release) => new CommittedWatch<ConversationView>(value, release),
			context,
		);
		const signal = context.abortSignal;
		if (signal?.aborted) {
			observer.cancel();
			throw signal.reason;
		}
		if (signal !== undefined) observer.observeCancellation(signal);
		return observer;
	}

	attach<O extends ViewObserver>(
		id: ConversationId,
		create: (value: ConversationView, release: () => void, storage: Storage) => O | Promise<O>,
		context: Context,
	): Promise<{ observer: O; detach: () => void }> {
		return this.#session.readOnLine(async () => {
			const mount = this.#mounts.get(id) ?? (await this.#build(id, context));
			const detach = (): void => {
				mount.observers.delete(observer);
				const isEmpty = mount.observers.size === 0;
				if (isEmpty && this.#mounts.get(id) === mount) {
					this.#mounts.delete(id);
				}
			};
			const observer = await create(mount.value, detach, this.#storage);
			if (this.#closed) throw closedError();
			context.abortSignal?.throwIfAborted();
			this.#mounts.set(id, mount);
			mount.observers.add(observer);
			return { observer, detach };
		});
	}

	async #build(id: ConversationId, context: Context): Promise<Mount> {
		const conversation = await this.#storage.conversation(id, context);
		if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
		const bounds = await captureContextBounds(this.#storage, id, context);
		const entries = await activeEntries(this.#storage, id, bounds, context);
		const docs: Record<string, JsonObject> = {};
		const incarnations = new Map<string, { id: DocumentId; version: number }>();
		for (const token of MOUNTED) {
			const loaded = await this.#session.conversationDocumentOnLine(token, id, context);
			if (loaded === undefined) continue;
			docs[token.definition.kind] = loaded.value;
			incarnations.set(token.definition.kind, { id: loaded.record.id, version: loaded.version });
		}
		return { value: { conversation, entries, docs }, docs: incarnations, observers: new Set() };
	}
}

export function conversationViews(harness: object): ConversationViews {
	const views = VIEWS.get(harness);
	if (views === undefined) {
		throw new Error("Not a Harness");
	}

	return views;
}
