import type { AttachedReplicatedState, Context, Draft, JsonValue } from "@huranth/chord";
import type { Op } from "@huranth/chord/delta";
import type { Message, Models } from "@huranth/gama-ai";
import type { ExecutionEnv } from "./env/index.ts";
import type {
	Agent,
	ContextView,
	ConversationHandle,
	RegistrySnapshot,
	Settings,
	SettledTask,
} from "./harness/types.ts";

export type JsonObject = { [key: string]: JsonValue };

export type Id<Kind extends string, Type = unknown> = number & {
	readonly [idBrand]: {
		readonly kind: Kind;
		readonly type: Type;
	};
};

export type ConversationId = Id<"conversation">;

export type EntryId = Id<"entry">;

export type TaskId<Result = unknown> = Id<"task", Result>;

export type SubmissionId = Id<"submission">;

export type DocumentId = Id<"document">;

export type Seq = number & { readonly [seqBrand]: "sequence" };

export type LatestConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "latest";
	readonly fork: "current" | "initial";
};

export type RewindableConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "rewindable";
	readonly fork: "asOf" | "current" | "initial";
};

export type DocumentSemantics =
	| { readonly scope: "session"; readonly history?: never; readonly fork?: never }
	| LatestConversationSemantics
	| RewindableConversationSemantics
	| { readonly scope: "task"; readonly history?: never; readonly fork?: never };

export type CheckpointInfo = {
	readonly deltasSinceBase: number;
};

export type CommonDocDefinition<T extends JsonObject> = {
	readonly kind: string;
	readonly version: number;
	initial(): T;
	migrate?(value: JsonObject, fromVersion: number): T;
	checkpointWhen?(value: Readonly<T>, ops: readonly Op[], info: CheckpointInfo): boolean;
};

export type DocDefinition<T extends JsonObject> = CommonDocDefinition<T> & DocumentSemantics;

export type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> = Omit<
	CommonDocDefinition<T>,
	"initial"
> &
	DocumentSemantics & {
		readonly family: true;
		initial(seed: I): T;
	};

export interface DocToken<T extends JsonObject, D extends DocDefinition<T>> {
	readonly definition: D;
	readonly [docType]?: T;
}

export interface DocFamilyToken<
	T extends JsonObject,
	I extends JsonValue,
	D extends DocFamilyDefinition<T, I>,
> {
	readonly definition: D;
	readonly [docType]?: T;
}

export type SessionDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & { readonly scope: "session" }
>;

export type ConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>;

export type RewindableConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & RewindableConversationSemantics
>;

export type TaskDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & { readonly scope: "task" }
>;

export type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "session" }
>;

export type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>;

export type RewindableConversationDocFamilyToken<
	T extends JsonObject,
	I extends JsonValue,
> = DocFamilyToken<T, I, DocFamilyDefinition<T, I> & RewindableConversationSemantics>;

export type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "task" }
>;

export type RunningTask<I, S, R> = TaskRecord<I, S, R> & {
	readonly state: Extract<TaskState<S, R>, { readonly status: "running" }>;
};

export type NextTaskState<S, R> = Extract<
	TaskState<S, R>,
	{ readonly status: "running" | "waiting" | "terminal" }
>;

export type PhaseHandler<I, P, S, R, H extends object> = (
	task: RunningTask<I, P, R>,
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
) => Promise<void>;

export interface HookRunner<H extends object> {
	each<K extends keyof H>(
		name: K,
		invoke: (handler: NonNullable<H[K]>) => void | Promise<void>,
	): Promise<void>;
}

export interface TaskRuntime<I, S, R, H extends object> extends DocumentObserver, DocumentReader {
	readonly taskId: TaskId<R>;
	readonly conversationId: ConversationId;
	readonly signal: AbortSignal;
	readonly registry: RegistrySnapshot;
	agent(context: Context): Promise<Agent>;
	readonly settings: Settings;
	readonly models: Models;
	env(context: Context): Promise<ExecutionEnv | undefined>;
	readonly hooks: HookRunner<H>;

	commit(
		change: (
			tx: Tx,
			current: RunningTask<I, S, R>,
		) => NextTaskState<S, R> | undefined | Promise<NextTaskState<S, R> | undefined>,
		context: Context,
	): Promise<void>;
	memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	getTask<T>(
		id: TaskId<T>,
		context: Context,
	): Promise<TaskRecord<JsonValue, JsonValue, T> | undefined>;
	waitForTask<T>(id: TaskId<T>, context: Context): Promise<SettledTask<T>>;
	outcomes<T>(ids: readonly TaskId<T>[], context: Context): Promise<TaskOutcome<T>[]>;
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	entry<D extends JsonValue>(
		token: Entry<D>,
		id: EntryId,
		context: Context,
	): Promise<TypedEntry<D> | undefined>;
	context(conversationId: ConversationId, context: Context, at?: EntryId): Promise<ContextView>;
	now(): number;
	report(error: unknown): void;
	sleep(until: number, context: Context): Promise<void>;
}

export type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
	readonly name: string;
	readonly version: number;
	initial(input: I): S;
	readonly phases: {
		readonly [P in S["phase"]]: PhaseHandler<I, Extract<S, { phase: P }>, S, R, H>;
	};
	abort(
		task: RunningTask<I, S, R>,
		runtime: TaskRuntime<I, S, R, H>,
		context: Context,
	): Promise<void>;
	migrate?(
		input: JsonValue,
		checkpoint: JsonValue,
		fromVersion: number,
	): {
		input: I;
		checkpoint: S;
	};
	readonly hooks?: H;
};

export interface Task<I, S extends { phase: string }, R, H extends object> {
	readonly definition: TaskDefinition<I, S, R, H>;
}

export type TaskOwnership =
	| { readonly kind: "conversation" }
	| { readonly kind: "task"; readonly taskId: TaskId };

export type JoinPolicy = "failFast" | "allSettled";

export type TaskOptions = {
	readonly ownership: TaskOwnership;
	readonly conversationId?: ConversationId;
	readonly background?: boolean;
};

export type ConversationOwnership =
	| { readonly kind: "ownerless" }
	| { readonly kind: "task"; readonly taskId: TaskId };

export type ConversationRecord = {
	readonly id: ConversationId;
	readonly parent?: {
		readonly conversationId: ConversationId;
		readonly at: EntryId;
	};
	readonly owner?: {
		readonly conversationId: ConversationId;
		readonly taskId: TaskId;
	};
};

export type ContextEdit = {
	readonly target: EntryId;
} & (
	| {
			readonly action: "omit";
			readonly messages?: never;
	  }
	| {
			readonly action: "replace";
			readonly messages: readonly Message[];
	  }
);

export type EntryRecord = {
	readonly id: EntryId;
	readonly conversationId: ConversationId;
	readonly kind: string;
	readonly model?: readonly Message[];
	readonly data?: JsonValue;
	readonly head?: EntryId;
	readonly edits?: readonly ContextEdit[];
	readonly byTaskId?: TaskId;
};

export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
	readonly head?: EntryId | "self";
};

export type TypedEntry<D extends JsonValue> = Omit<EntryRecord, "data"> &
	([D] extends [never] ? { readonly data?: never } : { readonly data: D });

export type TypedEntryDraft<D extends JsonValue> = Omit<EntryDraft, "kind" | "data"> &
	([D] extends [never] ? { readonly data?: never } : { readonly data: D });

export interface Entry<D extends JsonValue = never> {
	readonly kind: string;
	is(entry: EntryRecord | undefined): entry is TypedEntry<D>;
}

type SubmissionRecordBase = {
	readonly id: SubmissionId;
	readonly conversationId: ConversationId;
	readonly requestId?: string;
};

export type SubmissionRecord =
	| (SubmissionRecordBase & {
			readonly type: "input";
	  } & (
				| {
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						readonly status: "placed";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer: EntryId;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						readonly status: "unanswered";
						readonly entry?: EntryId;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			))
	| (SubmissionRecordBase & {
			readonly type: "write";
	  } & (
				| {
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						readonly status: "unanswered";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			));

export type SubmissionSettlement =
	| { readonly status: "done"; readonly answer: EntryId }
	| { readonly status: "unanswered"; readonly reason: string; readonly detail?: JsonValue };

export type SubmissionCreate = SubmissionRecord extends infer Record
	? Record extends SubmissionRecord
		? Omit<Record, "id">
		: never
	: never;

export type TaskOutcomeError = {
	readonly message: string;
	readonly detail?: JsonValue;
};

export type TaskOutcome<R> =
	| {
			readonly status: "completed";
			readonly result: R;
			readonly error?: never;
			readonly reason?: never;
	  }
	| {
			readonly status: "failed";
			readonly error: TaskOutcomeError;
			readonly result?: R;
			readonly reason?: never;
	  }
	| {
			readonly status: "aborted";
			readonly reason?: string;
			readonly result?: R;
			readonly error?: never;
	  }
	| {
			readonly status: "orphaned";
			readonly reason: string;
			readonly result?: never;
			readonly error?: never;
	  }
	| {
			readonly status: "faulted";
			readonly error: TaskOutcomeError;
			readonly result?: never;
			readonly reason?: never;
	  };

export type TaskState<S, R> =
	| {
			readonly status: "pending";
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			readonly status: "running";
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			readonly status: "waiting";
			readonly checkpoint: S;
			readonly on: readonly TaskId[];
			readonly policy: JoinPolicy;
			readonly outcome?: never;
	  }
	| {
			readonly status: "completing";
			readonly checkpoint?: never;
			readonly outcome: TaskOutcome<R>;
	  }
	| {
			readonly status: "terminal";
			readonly checkpoint?: never;
			readonly outcome: TaskOutcome<R>;
	  };

type TaskRecordBase<I, R> = {
	readonly id: TaskId<R>;
	readonly conversationId: ConversationId;
	readonly kind: string;
	readonly version: number;
	readonly input: I;
	readonly owner?: TaskId;
	readonly background: boolean;
	readonly abortRequested: boolean;
};

export type TaskRecord<I, S, R> = TaskRecordBase<I, R> &
	(
		| {
				readonly state: Extract<
					TaskState<S, R>,
					{ readonly status: "pending" | "running" | "waiting" }
				>;
				readonly memos?: Readonly<Record<string, JsonValue>>;
		  }
		| {
				readonly state: Extract<
					TaskState<S, R>,
					{ readonly status: "completing" | "terminal" }
				>;
				readonly memos?: never;
		  }
	);

export type DocumentRecord = {
	readonly id: DocumentId;
	readonly kind: string;
	readonly key?: string;
	readonly createdAt: Seq;
	readonly retiredAt?: Seq;
} & (
	| {
			readonly scope: { readonly kind: "session" };
			readonly history?: never;
			readonly fork?: never;
	  }
	| ({
			readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId };
	  } & (
			| {
					readonly history: "latest";
					readonly fork: "current" | "initial";
			  }
			| {
					readonly history: "rewindable";
					readonly fork: "asOf" | "current" | "initial";
			  }
	  ))
	| {
			readonly scope: { readonly kind: "task"; readonly taskId: TaskId };
			readonly history?: never;
			readonly fork?: never;
	  }
);

export type DocumentCreate = DocumentRecord extends infer Record
	? Record extends DocumentRecord
		? Omit<Record, "createdAt" | "retiredAt">
		: never
	: never;

export type Page<T, C> = {
	readonly items: readonly T[];
	readonly next?: C;
};

export type Cursor = Readonly<Record<string, JsonValue>>;

export type ConversationQuery = {
	readonly ownerConversationId?: ConversationId;
	readonly ownerTaskId?: TaskId;
};

export type EntryQuery = {
	readonly conversationId: ConversationId;
	readonly minEntryId?: EntryId;
	readonly maxEntryId?: EntryId;
};

export type TaskQuery = {
	readonly conversationId?: ConversationId;
	readonly kind?: string;
	readonly status?: TaskState<JsonValue, JsonValue>["status"];
	readonly abortRequested?: boolean;
	readonly background?: boolean;
};

export type SubmissionQuery = {
	readonly conversationId?: ConversationId;
	readonly status?: SubmissionRecord["status"];
};

export type DocumentPoint = Seq | "current";

export type DocumentAddress = {
	readonly kind: string;
	readonly scope: DocumentRecord["scope"];
	readonly key?: string;
};

export type DocumentQuery = {
	readonly scope: DocumentRecord["scope"];
	readonly at: DocumentPoint;
	readonly kind?: string;
};

export type DocumentContent =
	| {
			readonly version: number;
			readonly kind: "base";
			readonly value: JsonObject;
	  }
	| {
			readonly version: number;
			readonly kind: "delta";
			readonly ops: readonly Op[];
	  };

export type DocumentCopySource = {
	readonly id: DocumentId;
	readonly at: DocumentPoint;
};

export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly version: number;
	readonly value: JsonObject;
	readonly deltasSinceBase: number;
};

export type StorageWrite =
	| { readonly type: "conversation"; readonly value: ConversationRecord }
	| { readonly type: "entry"; readonly value: EntryRecord }
	| { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
	| { readonly type: "submission"; readonly value: SubmissionRecord }
	| {
			readonly type: "document.create";
			readonly record: DocumentCreate;
			readonly content: Extract<DocumentContent, { readonly kind: "base" }>;
	  }
	| {
			readonly type: "document.copy";
			readonly record: DocumentCreate;
			readonly source: DocumentCopySource;
	  }
	| {
			readonly type: "document.change";
			readonly id: DocumentId;
			readonly content: DocumentContent;
	  }
	| { readonly type: "document.retire"; readonly id: DocumentId };

export type DocumentCommitChange =
	| {
			readonly type: "document";
			readonly record: DocumentRecord;
			readonly conversationId: ConversationId | undefined;
			readonly version: number | undefined;
			readonly value: JsonObject | null;
			readonly ops: readonly Op[];
	  }
	| {
			readonly type: "document.copy";
			readonly record: DocumentRecord;
			readonly conversationId: ConversationId;
			readonly source: DocumentCopySource;
	  };

export type TableCommitChange = Extract<
	StorageWrite,
	{ readonly type: "conversation" | "entry" | "task" | "submission" }
>;

export type CommitChange = TableCommitChange | DocumentCommitChange;

export type CommitPublication = {
	readonly seq: Seq;
	readonly changes: readonly CommitChange[];
};

export interface Tx {
	conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
	entry(id: EntryId): Promise<EntryRecord | undefined>;
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
	task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<ConversationRecord, Cursor>>;
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<EntryRecord, Cursor>>;
	latestHeadMarker(
		conversationId: ConversationId,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
	): Promise<SubmissionRecord | undefined>;

	createConversation(options: {
		readonly ownership: ConversationOwnership;
	}): Promise<ConversationRecord>;
	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord>;
	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	appendEntry<D extends JsonValue>(
		token: Entry<D>,
		conversationId: ConversationId,
		value: TypedEntryDraft<NoInfer<D>>,
	): Promise<TypedEntry<D>>;
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: TaskOptions,
	): Promise<TaskId<R>>;
	createSubmission(create: SubmissionCreate): Promise<SubmissionRecord>;
	settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void;
	placeSubmission(id: SubmissionId, entry: EntryId): void;

	doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
	doc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
	): Promise<Draft<T>>;
	doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;

	retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
	retireDoc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
	): Promise<void>;
	retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
	): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
	): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
	): Promise<void>;
}

export type DocumentState<T extends JsonObject> = AttachedReplicatedState<Readonly<T> | null>;

export type WatchEnd =
	| { readonly reason: "stopped" | "cancelled" | "session_closed" | "retired" }
	| { readonly reason: "listener_error"; readonly error: Error };

export interface WatchHandle<T> {
	readonly value: T;
	start(listener: (value: T, ops: readonly Op[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
	readonly closed: Promise<WatchEnd>;
}

export type DocumentWatch<T extends JsonObject> = WatchHandle<Readonly<T> | null>;

export type DocumentReader = Pick<Session, "snapshot" | "snapshotAsOf">;

export interface DocumentObserver {
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
}

export interface Session extends DocumentObserver {
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	close(context: Context): Promise<void>;
	subscribeCommits(
		listener: (publication: CommitPublication, context: Context) => void,
	): () => void;
	subscribeClose(listener: () => void): () => void;

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
}

export interface Storage {
	commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;

	mintId<I extends Id<string>>(): Promise<I>;

	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>>;

	entry(
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;

	task(
		id: TaskId,
		context: Context,
	): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>>;

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined>;

	findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		context: Context,
	): Promise<DocumentRecord | undefined>;

	document(
		id: DocumentId,
		at: DocumentPoint,
		context: Context,
	): Promise<StoredDocument | undefined>;

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>>;

	close(context: Context): Promise<void>;
}

declare const idBrand: unique symbol;

declare const seqBrand: unique symbol;

export const ROOT_CONVERSATION_ID = 1 as ConversationId;

declare const docType: unique symbol;
