import { type Context, type JsonValue, replicatedState } from "@huranth/chord";
import { awaitWithContext, withoutAbortSignal } from "@huranth/chord/context";
import { type Op, track } from "@huranth/chord/delta";
import {
	type AnyDocToken,
	checkRecordScope,
	checkRecordVersion,
	materializeDocument,
	resolveAddress,
} from "../documents.ts";
import { StorageRejected } from "../errors.ts";
import { idFromNumber } from "../ids.ts";
import type {
	CommitChange,
	CommitPublication,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	DocumentAddress,
	DocumentCommitChange,
	DocumentRecord,
	DocumentState,
	DocumentWatch,
	EntryId,
	JsonObject,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	Seq,
	Session,
	SessionDocFamilyToken,
	SessionDocToken,
	Storage,
	StorageWrite,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	Tx,
} from "../types.ts";
import {
	CommittedStateSource,
	CommittedWatch,
	type ObservedDocumentValue,
	RETIREMENT_OPERATIONS,
} from "./observation.ts";
import {
	type LoadedDocument,
	Transaction,
	type TransactionHost,
	type TransactionScope,
} from "./transaction.ts";

function observedOperations(
	observed: { version: number },
	change: Extract<DocumentCommitChange, { readonly type: "document" }>,
): readonly Op[] {
	if (change.value === null) return RETIREMENT_OPERATIONS;
	if (change.version === observed.version) return change.ops;
	observed.version = change.version!;
	return [["r", change.value]];
}

function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

export function createSession(storage: Storage): Session {
	return new SessionImpl(storage);
}

export class SessionImpl implements Session {
	readonly #storage: Storage;
	readonly #documents = new Map<string, LoadedDocument>();
	readonly #commitListeners = new Set<
		(publication: CommitPublication, context: Context) => void
	>();
	readonly #closeListeners = new Set<() => void>();
	readonly #host: TransactionHost;
	#tail: Promise<void> = Promise.resolve();
	#closing: Promise<void> | undefined;
	#poison: { readonly error: unknown } | undefined;

	constructor(storage: Storage) {
		this.#storage = storage;
		this.#host = {
			storage,
			cached: (id) => this.#documents.get(id),
			load: (definition, addressId, address, context) =>
				this.#loadDocument(definition, addressId, address, context),
			install: (document) => {
				this.#documents.set(document.addressId, document);
			},
			evict: (id, recordId) => {
				if (this.#documents.get(id)?.record.id === recordId) this.#documents.delete(id);
			},
			conversationCreated: (tx, record) => this.conversationCreated(tx, record),
		};
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		return this.commitWith(change, context);
	}

	commitWith<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope?: TransactionScope,
	): Promise<T> {
		try {
			this.#assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(() => this.#runCommit(change, context, scope));
	}

	readOnLine<T>(job: () => Promise<T>): Promise<T> {
		try {
			this.#assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(async () => {
			this.#assertHealthy();
			return job();
		});
	}

	async conversationDocumentOnLine(
		token: ConversationDocToken<JsonObject>,
		conversationId: ConversationId,
		context: Context,
	): Promise<
		| { readonly record: DocumentRecord; readonly version: number; readonly value: JsonObject }
		| undefined
	> {
		const definition = token.definition;
		const resolved = resolveAddress(definition, [conversationId, context]);
		const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
		if (loaded === undefined) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return { record: loaded.record, version: loaded.valueVersion, value: loaded.tracker.value };
	}

	snapshot<T extends JsonObject>(
		token: SessionDocToken<T>,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	async snapshot(
		token: AnyDocToken,
		...args: readonly unknown[]
	): Promise<JsonObject | undefined> {
		this.#assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const cached = this.#documents.get(resolved.id);
		const loaded =
			cached?.valueVersion === definition.version
				? cached
				: await this.#enqueue(async () => {
						this.#assertHealthy();
						return this.#loadDocument(definition, resolved.id, resolved.address, context);
					});
		if (loaded === undefined) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return loaded.tracker.value;
	}

	documentState<T extends JsonObject>(
		token: SessionDocToken<T>,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState(
		token: AnyDocToken,
		...args: readonly unknown[]
	): Promise<DocumentState<JsonObject> | undefined> {
		try {
			this.#assertUsable();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const context = args[resolved.nextArgument] as Context;
			return this.#enqueue(async () => {
				this.#assertHealthy();
				const loaded = await this.#loadDocument(
					definition,
					resolved.id,
					resolved.address,
					context,
				);
				if (loaded === undefined) return undefined;
				const { observer: source, detach } = this.#attachDocument(
					definition,
					loaded,
					(value, release) => new CommittedStateSource<ObservedDocumentValue>(value, release),
				);
				try {
					return replicatedState(source) as DocumentState<JsonObject>;
				} catch (error) {
					detach();
					throw error;
				}
			});
		} catch (error) {
			return Promise.reject(error);
		}
	}

	watchDoc<T extends JsonObject>(
		token: SessionDocToken<T>,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	async watchDoc(
		token: AnyDocToken,
		...args: readonly unknown[]
	): Promise<DocumentWatch<JsonObject> | undefined> {
		this.#assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const signal = context.abortSignal;
		let cancelled = signal?.aborted ?? false;
		const markCancelled = (): void => {
			cancelled = true;
		};
		signal?.addEventListener("abort", markCancelled, { once: true });
		try {
			const watch = await this.#enqueue(async () => {
				this.#assertHealthy();
				if (cancelled) throw cancellationError(signal!);
				const loaded = await this.#loadDocument(
					definition,
					resolved.id,
					resolved.address,
					context,
				);
				if (cancelled) throw cancellationError(signal!);
				if (loaded === undefined) return undefined;
				return this.#attachDocument(
					definition,
					loaded,
					(value, release) => new CommittedWatch<ObservedDocumentValue>(value, release),
				).observer;
			});
			if (watch === undefined) return undefined;
			if (cancelled) {
				watch.cancel();
				throw cancellationError(signal!);
			}
			if (signal !== undefined) watch.observeCancellation(signal);
			return watch as DocumentWatch<JsonObject>;
		} finally {
			signal?.removeEventListener("abort", markCancelled);
		}
	}

	snapshotAsOf<T extends JsonObject>(
		token: RewindableConversationDocToken<T>,
		conversationId: ConversationId,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshotAsOf<T extends JsonObject, I extends JsonValue>(
		token: RewindableConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	async snapshotAsOf(
		token: AnyDocToken,
		...args: readonly unknown[]
	): Promise<JsonObject | undefined> {
		this.#assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		if (resolved.address.scope.kind !== "conversation") {
			throw new TypeError("Session.snapshotAsOf() requires a conversation document");
		}
		const conversationId = resolved.address.scope.conversationId;
		const atValue = args[resolved.nextArgument];
		if (typeof atValue !== "number" || !Number.isSafeInteger(atValue)) {
			throw new TypeError("Session.snapshotAsOf() requires an entry ID");
		}
		const at = idFromNumber<EntryId>(atValue);
		const context = args[resolved.nextArgument + 1] as Context;
		return this.#enqueue(async () => {
			this.#assertHealthy();
			const storedEntry = await this.#storage.entry(conversationId, at, context);
			if (storedEntry === undefined) {
				throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
			}
			const address: DocumentAddress = {
				...resolved.address,
				scope: { kind: "conversation", conversationId: storedEntry.entry.conversationId },
			};
			const record = await this.#storage.findDocument(address, storedEntry.commitSeq, context);
			if (record === undefined) return undefined;
			const stored = await this.#storage.document(record.id, storedEntry.commitSeq, context);
			if (stored === undefined) {
				throw new Error(`Historical document ${record.id} (${record.kind}) cannot be read`);
			}
			return materializeDocument(definition, stored);
		});
	}

	close(context: Context): Promise<void> {
		if (this.#closing === undefined) {
			const cleanup = withoutAbortSignal(context);
			this.#closing = Promise.resolve()
				.then(() => this.beforeClose())
				.then(() =>
					this.#enqueue(async () => {
						this.#commitListeners.clear();
						this.#documents.clear();
						await this.#storage.close(cleanup);
					}),
				);
			const listeners = [...this.#closeListeners];
			this.#closeListeners.clear();
			for (const listener of listeners) {
				listener();
			}
		}
		return awaitWithContext(this.#closing, context);
	}

	protected conversationCreated(_tx: Transaction, _record: ConversationRecord): Promise<void> {
		return Promise.resolve();
	}

	protected beforeClose(): Promise<void> {
		return Promise.resolve();
	}

	subscribeCommits(
		listener: (publication: CommitPublication, context: Context) => void,
	): () => void {
		this.#assertUsable();
		this.#commitListeners.add(listener);
		return () => this.#commitListeners.delete(listener);
	}

	subscribeClose(listener: () => void): () => void {
		this.#assertUsable();
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	unloadDocuments(): Promise<void> {
		return this.#enqueue(async () => {
			this.#documents.clear();
		});
	}

	async #runCommit<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope?: TransactionScope,
	): Promise<T> {
		this.#assertHealthy();
		context.abortSignal?.throwIfAborted();
		const tx = new Transaction(this.#host, context, scope);
		let result: T;
		try {
			result = await change(tx);
		} catch (error) {
			await tx.settleFailure();
			throw error;
		}
		const writes = await tx.settleSuccess();
		if (writes.length === 0) {
			tx.discard();
			return result;
		}
		let seq: Seq;
		try {
			seq = await this.#storage.commit(writes, withoutAbortSignal(context));
		} catch (error) {
			tx.discard();
			if (!(error instanceof StorageRejected)) this.#poison = { error };
			throw error;
		}
		let documents: DocumentCommitChange[];
		try {
			documents = tx.adopt(seq);
		} catch (error) {
			this.#poison = { error };
			throw error;
		}
		this.#publish(seq, writes, documents, context);
		return result;
	}

	#publish(
		seq: Seq,
		writes: readonly StorageWrite[],
		documents: readonly DocumentCommitChange[],
		context: Context,
	): void {
		if (this.#commitListeners.size === 0) return;
		const changes: CommitChange[] = [];
		for (const write of writes) {
			switch (write.type) {
				case "conversation":
				case "entry":
				case "task":
				case "submission":
					changes.push(write);
			}
		}
		for (const document of documents) {
			changes.push(document);
		}
		const publication: CommitPublication = { seq, changes };
		for (const listener of [...this.#commitListeners]) {
			try {
				listener(publication, context);
			} catch {
				// Already durable
			}
		}
	}

	#attachDocument<O extends CommittedStateSource | CommittedWatch>(
		definition: AnyDocToken["definition"],
		loaded: LoadedDocument,
		create: (value: JsonObject, detach: () => void) => O,
	): { observer: O; detach: () => void } {
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		let unsubscribeCommit = (): void => {};
		let unsubscribeClose = (): void => {};
		const detach = (): void => {
			unsubscribeCommit();
			unsubscribeClose();
		};
		const observer = create(loaded.tracker.value, detach);
		const observed = { version: loaded.valueVersion };
		unsubscribeCommit = this.subscribeCommits((publication, context) => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.record.id !== loaded.record.id) continue;
				const frameContext =
					observer instanceof CommittedStateSource ? withoutAbortSignal(context) : context;
				const ops = observedOperations(observed, change);
				if (ops.length === 0) continue;
				observer.advance(change.value, ops, frameContext);
			}
		});
		unsubscribeClose = this.subscribeClose(() => observer.closeSession());
		return { observer, detach };
	}

	async #loadDocument(
		definition: AnyDocToken["definition"],
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined> {
		const cached = this.#documents.get(addressId);
		if (cached?.valueVersion === definition.version) return cached;
		if (cached !== undefined) this.#documents.delete(addressId);
		const record = await this.#storage.findDocument(address, "current", context);
		if (record === undefined) return undefined;
		const stored = await this.#storage.document(record.id, "current", context);
		if (stored === undefined)
			throw new Error(`Current document ${record.id} (${record.kind}) cannot be read`);
		const value = materializeDocument(definition, stored);
		const loaded: LoadedDocument = {
			addressId,
			record: stored.record,
			storedVersion: stored.version,
			valueVersion: definition.version,
			deltasSinceBase: stored.deltasSinceBase,
			tracker: track(value),
		};
		this.#documents.set(addressId, loaded);
		return loaded;
	}

	#enqueue<T>(job: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(job);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#assertUsable(): void {
		if (this.#closing !== undefined) throw new Error("Session is closed");
		this.#assertHealthy();
	}

	#assertHealthy(): void {
		if (this.#poison !== undefined) {
			throw new Error(
				"Session is poisoned by a failed commit after storage admission; reopen it",
				{
					cause: this.#poison.error,
				},
			);
		}
	}
}
