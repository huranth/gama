import { type Context, copyJson, type JsonValue } from "@huranth/chord";
import { awaitWithContext, withAbortSignal } from "@huranth/chord/context";
import type { Models } from "@huranth/gama-ai";
import type { ExecutionEnv } from "../env/index.ts";
import type { SessionImpl } from "../session/session.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	CommitPublication,
	ConversationId,
	DocumentWatch,
	EntryId,
	EntryRecord,
	HookRunner,
	JsonObject,
	NextTaskState,
	RunningTask,
	Storage,
	TaskDefinition,
	TaskId,
	TaskOutcome,
	TaskRecord,
	TaskRuntime,
	TaskState,
} from "../types.ts";
import { agentHooks } from "./agent.ts";
import { readContext } from "./context.ts";
import type {
	Agent,
	AnyTask,
	ConversationHandle,
	HarnessInspection,
	RegistryReader,
	RegistrySnapshot,
	Settings,
	SettledTask,
	TaskInspection,
} from "./types.ts";
import { closedError, SCAN_PAGE_SIZE, scanAll, Waiters } from "./util.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

type RunnableTaskRecord = Extract<
	AnyTaskRecord,
	{ readonly state: { readonly status: "pending" | "running" | "waiting" } }
>;

type Checkpoint = { readonly phase: string };

type ErasedDefinition = TaskDefinition<JsonValue, Checkpoint, JsonValue, object>;

type ErasedRuntime = TaskRuntime<JsonValue, Checkpoint, JsonValue, object>;

type ErasedRunningTask = RunningTask<JsonValue, Checkpoint, JsonValue>;

type BlockedReason = "missing_task" | "task_too_old" | "migration_failed";

type Resolution =
	| { readonly kind: "ready"; readonly task: AnyTask; readonly record: RunnableTaskRecord }
	| { readonly kind: "blocked"; readonly reason: BlockedReason };

type Fit =
	| { readonly task: AnyTask; readonly migrates: boolean }
	| { readonly reason: BlockedReason; readonly error?: unknown };

type Invocation = {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly mode: "run" | "abort";
	readonly controller: AbortController;
	readonly context: Context;
	readonly watches: Set<DocumentWatch<JsonObject>>;
	ended: boolean;
	readonly done: Promise<void>;
	readonly finish: () => void;
};

type Phase = {
	readonly snapshot: () => RegistrySnapshot;
	readonly task: () => AnyTask;
	agent: Promise<Agent> | undefined;
};

type Reservation = {
	readonly invocation: Invocation;
	readonly task: AnyTask;
	readonly snapshot: RegistrySnapshot;
};

type ReportedTask = { readonly task: AnyTask | undefined } | undefined;

type PhaseResult = {
	readonly checkpoint: Checkpoint;
	readonly failure?: { readonly error: unknown };
};

type Decision = boolean | { readonly fault: unknown };

export type SchedulerOutcome = Extract<
	TaskOutcome<JsonValue>,
	{ readonly status: "faulted" | "orphaned" }
>;

export type InvocationBinding = { readonly signal: AbortSignal; check(): void };

type TaskNode = Pick<AnyTaskRecord, "conversationId" | "owner" | "background">;

type Up = { readonly task: TaskId } | { readonly conversation: ConversationId };

type Step =
	| { readonly task: TaskId; readonly node: TaskNode }
	| { readonly conversation: ConversationId }
	| { readonly unknown: true };

type Overlay = {
	readonly tasks: ReadonlyMap<TaskId, AnyTaskRecord>;
	readonly edges: ReadonlyMap<ConversationId, TaskId | null>;
};

type Scope = { readonly conversation: ConversationId } | { readonly roots: true };

export type TaskSchedulerOptions = {
	readonly session: SessionImpl;
	readonly storage: Storage;
	readonly registry: RegistryReader;
	readonly models: Models;
	readonly agent: (
		conversationId: ConversationId,
		snapshot: RegistrySnapshot,
		context: Context,
	) => Promise<Agent>;
	readonly settings: () => Settings;
	readonly env: (
		conversationId: ConversationId,
		context: Context,
	) => Promise<ExecutionEnv | undefined>;
	readonly now: () => number;
	readonly report: (error: unknown) => void;
	readonly settleOutcome: (
		tx: Transaction,
		record: AnyTaskRecord,
		outcome: SchedulerOutcome,
	) => Promise<void>;
	readonly withdrawInputs: (tx: Transaction, conversationId: ConversationId) => Promise<void>;
	readonly conversation: (
		id: ConversationId,
		binding: InvocationBinding,
		context: Context,
	) => Promise<ConversationHandle | undefined>;
	readonly context: Context;
};
const MAX_TIMER_DELAY = 2_147_483_647;
const LIVE_STATUSES = ["pending", "running", "waiting", "completing"] as const;

function cancellationIntent(record: AnyTaskRecord): boolean {
	return record.state.status !== "terminal" && (record.abortRequested || failedOutcome(record));
}

function failedOutcome(record: AnyTaskRecord): boolean {
	const state = record.state;
	return (
		(state.status === "completing" || state.status === "terminal") &&
		state.outcome.status !== "completed"
	);
}

function parentOf(node: TaskNode): Up {
	return node.owner !== undefined ? { task: node.owner } : { conversation: node.conversationId };
}

function nodeOf(record: AnyTaskRecord): TaskNode {
	return {
		conversationId: record.conversationId,
		...(record.owner === undefined ? {} : { owner: record.owner }),
		background: record.background,
	};
}

function overlayOf(tx: Transaction): Overlay {
	const tasks = new Map(tx.stagedTasks().map((record) => [record.id, record]));
	const edges = new Map(
		tx.stagedConversations().map((record) => [record.id, record.owner?.taskId ?? null]),
	);
	return { tasks, edges };
}

function memoOf(record: AnyTaskRecord | undefined, name: string): JsonValue | undefined {
	const memos = record?.memos;
	return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined;
}

function sessionMethod(
	session: SessionImpl,
	name: "snapshot" | "snapshotAsOf" | "watchDoc",
): (...args: readonly unknown[]) => Promise<unknown> {
	return (session[name] as (...args: readonly unknown[]) => Promise<unknown>).bind(session);
}

function missingMigration(record: AnyTaskRecord, definition: ErasedDefinition): Error {
	return new Error(
		`Task ${record.kind} version ${definition.version} has no migration from ${record.version}`,
	);
}

function erased(task: AnyTask): ErasedDefinition {
	return task.definition as unknown as ErasedDefinition;
}

function endedError(invocation: Invocation): Error {
	return new Error(`Task ${invocation.taskId} invocation has ended`);
}

function withState(record: AnyTaskRecord, state: TaskState<JsonValue, JsonValue>): AnyTaskRecord {
	if (state.status !== "terminal" && state.status !== "completing")
		return { ...record, state } as AnyTaskRecord;
	const { memos: _memos, ...rest } = record;
	return { ...rest, state };
}

function canReserve(task: AnyTask, record: AnyTaskRecord): boolean {
	const definition = task.definition;
	return (
		definition.version === record.version ||
		(definition.version > record.version && definition.migrate !== undefined)
	);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
		return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
			return false;
		return left.every((value, index) => jsonEqual(value, right[index]));
	}
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

export class TaskScheduler {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #registry: RegistryReader;
	readonly #models: Models;
	readonly #agent: TaskSchedulerOptions["agent"];
	readonly #settings: TaskSchedulerOptions["settings"];
	readonly #env: TaskSchedulerOptions["env"];
	readonly #now: () => number;
	readonly #report: (error: unknown) => void;
	readonly #settleOutcome: TaskSchedulerOptions["settleOutcome"];
	readonly #withdrawInputs: TaskSchedulerOptions["withdrawInputs"];
	readonly #conversation: TaskSchedulerOptions["conversation"];
	readonly #context: Context;
	readonly #live = new Map<TaskId, AnyTaskRecord>();
	readonly #invocations = new Map<TaskId, Invocation>();
	readonly #taskWaiters = new Waiters<TaskId, SettledTask<JsonValue>>();
	readonly #idleWaiters = new Waiters<ConversationId | undefined, void>();
	readonly #failedMigrations = new Map<
		TaskId,
		{ readonly task: AnyTask; readonly error: unknown }
	>();
	readonly #edges = new Map<ConversationId, TaskId | null>();
	readonly #conversationOwners = new Set<TaskId>();
	readonly #settled = new Map<TaskId, TaskNode>();
	readonly #failFastChecks = new Set<TaskId>();
	#reconcileScheduled = false;
	#cascadePending = false;
	#unsubscribeRegistry: () => void = () => {};
	#enabled = false;
	#closing = false;
	#dirty = false;
	#draining = false;

	constructor(options: TaskSchedulerOptions) {
		this.#session = options.session;
		this.#storage = options.storage;
		this.#registry = options.registry;
		this.#models = options.models;
		this.#agent = options.agent;
		this.#settings = options.settings;
		this.#env = options.env;
		this.#now = options.now;
		this.#report = options.report;
		this.#settleOutcome = options.settleOutcome;
		this.#withdrawInputs = options.withdrawInputs;
		this.#conversation = options.conversation;
		this.#context = options.context;
	}

	async open(context: Context): Promise<void> {
		this.#session.subscribeCommits((publication) => this.#observe(publication));
		this.#session.subscribeClose(() => this.#seal());
		this.#unsubscribeRegistry = this.#registry.subscribe(() => this.#kick());
		await this.#session.commitWith(async (tx) => {
			const scans = [];
			for (const status of LIVE_STATUSES) {
				scans.push(await scanAll((cursor) => tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)));
			}
			for (const records of scans) {
				for (const record of records) {
					this.#live.set(record.id, record);
					if (record.state.status === "running") {
						tx.setTask(
							withState(record, { status: "pending", checkpoint: record.state.checkpoint }),
						);
					}
					if (record.state.status === "waiting" && record.state.policy === "failFast") {
						this.#failFastChecks.add(record.id);
					}
				}
			}
		}, context);
		this.#cascadePending = true;
		this.#scheduleReconcile();
	}

	resume(): void {
		this.#enabled = true;
		this.#kick();
	}

	async join(): Promise<void> {
		await Promise.allSettled(
			[...this.#invocations.values()].map((invocation) => invocation.done),
		);
	}

	async abort(id: TaskId, context: Context): Promise<"marked" | "terminal"> {
		const marked = await this.#session.commitWith(async (tx) => {
			const current = await tx.task(id);
			if (current === undefined) throw new Error(`Task ${id} does not exist`);
			if (current.state.status === "terminal") return { result: "terminal" as const };
			const invocation = this.#invocations.get(id);
			if (invocation === undefined && current.state.status !== "completing") {
				await this.#loadScopes(false);
				if (!this.#ownedLive().has(id)) {
					const resolution = this.#resolve(
						current as RunnableTaskRecord,
						this.#registry.snapshot(),
					);
					if (resolution.kind === "blocked") {
						await this.#terminate(tx, current, {
							status: "orphaned",
							reason: resolution.reason,
						});
						return { result: "marked" as const };
					}
				}
			}
			if (!current.abortRequested) tx.setTask({ ...current, abortRequested: true });
			return {
				result: "marked" as const,
				run: invocation?.mode === "run" ? invocation : undefined,
			};
		}, context);
		if (marked.run !== undefined) await awaitWithContext(marked.run.done, context);
		return marked.result;
	}

	async waitForTask(id: TaskId, context: Context): Promise<SettledTask<JsonValue>> {
		const found = await this.#session.readOnLine(async () => {
			if (this.#closing) throw closedError();
			if (this.#live.has(id)) return { promise: this.#taskWaiters.add(id, context) };
			const record = await this.#storage.task(id, context);
			if (record === undefined) throw new Error(`Task ${id} does not exist`);
			return { promise: Promise.resolve(record as SettledTask<JsonValue>) };
		});
		return found.promise;
	}

	waitForIdle(conversationId: ConversationId | undefined, context: Context): Promise<void> {
		if (this.#closing) return Promise.reject(closedError());
		if (this.#idle(conversationId)) return Promise.resolve();
		this.#scheduleReconcile();
		return this.#idleWaiters.add(conversationId, context);
	}

	async abortConversation(
		conversationId: ConversationId,
		background: boolean,
		context: Context,
	): Promise<void> {
		const reached = await this.#session.commitWith(async (tx) => {
			const queued = await this.#loadScopes(true);
			const scope = { conversation: conversationId };
			const reached: TaskId[] = [];
			for (const record of this.#live.values()) {
				if (record.background && !background) continue;
				if (this.#inScope(parentOf(record), scope, background) !== true) continue;
				reached.push(record.id);
				if (!record.abortRequested) tx.setTask({ ...record, abortRequested: true });
			}
			for (const id of queued) {
				if (this.#inScope({ conversation: id }, scope, background) === true)
					await this.#withdrawInputs(tx, id);
			}
			return reached;
		}, context);
		if (background) for (const id of reached) await this.waitForTask(id, context);
		await this.waitForIdle(conversationId, context);
	}

	#observe(publication: CommitPublication): void {
		const updated: AnyTaskRecord[] = [];
		const failed: TaskId[] = [];
		let changed = false;
		for (const change of publication.changes) {
			if (change.type !== "task") continue;
			changed = true;
			const record = change.value;
			const previous = this.#live.get(record.id);
			if (failedOutcome(record) && (previous === undefined || !failedOutcome(previous)))
				failed.push(record.id);
			if (record.state.status === "terminal") {
				this.#live.delete(record.id);
				this.#failedMigrations.delete(record.id);
				this.#failFastChecks.delete(record.id);
				if (this.#conversationOwners.has(record.id))
					this.#settled.set(record.id, nodeOf(record));
				this.#taskWaiters.resolve(record.id, record as SettledTask<JsonValue>);
				this.#scheduleReconcile();
				continue;
			}
			if (record.abortRequested && previous?.abortRequested !== true) {
				this.#cascadePending = true;
				const invocation = this.#invocations.get(record.id);
				if (invocation?.mode === "run") invocation.controller.abort();
			}
			const status = record.state.status;
			if (status === "completing" && previous?.state.status !== "completing") {
				if (cancellationIntent(record)) this.#cascadePending = true;
				this.#scheduleReconcile();
			}
			if (
				status === "waiting" &&
				record.state.policy === "failFast" &&
				previous?.state.status !== "waiting"
			) {
				this.#failFastChecks.add(record.id);
				this.#scheduleReconcile();
			}
			this.#live.set(record.id, record);
			updated.push(record);
		}
		for (const id of failed) {
			for (const record of this.#live.values()) {
				const state = record.state;
				if (
					state.status === "waiting" &&
					state.policy === "failFast" &&
					state.on.includes(id)
				) {
					this.#failFastChecks.add(record.id);
					this.#scheduleReconcile();
				}
			}
		}
		for (const change of publication.changes) {
			if (change.type === "conversation" && !this.#edges.has(change.value.id)) {
				this.#setEdge(change.value.id, change.value.owner?.taskId ?? null);
			}
		}
		for (const change of publication.changes) {
			if (
				change.type !== "submission" ||
				change.value.status !== "queued" ||
				change.value.type !== "input"
			)
				continue;
			const up = { conversation: change.value.conversationId };
			if (!this.#chainKnown(up) || this.#belowCancelled(up)) this.#cascadePending = true;
		}
		for (const record of updated) {
			if (!this.#chainKnown(parentOf(record))) this.#scheduleReconcile();
			else if (
				!record.background &&
				!record.abortRequested &&
				this.#belowCancelled(parentOf(record))
			) {
				this.#cascadePending = true;
			}
		}
		if (this.#cascadePending) this.#scheduleReconcile();
		if (!changed) return;
		this.#resolveIdleWaiters();
		this.#kick();
	}

	#resolveIdleWaiters(): void {
		for (const conversationId of this.#idleWaiters.keys()) {
			if (this.#idle(conversationId)) this.#idleWaiters.resolve(conversationId);
		}
	}

	#scheduleReconcile(): void {
		if (this.#reconcileScheduled || this.#closing) return;
		this.#reconcileScheduled = true;
		queueMicrotask(() => void this.#reconcile());
	}

	async #reconcile(): Promise<void> {
		this.#reconcileScheduled = false;
		const cascade = this.#cascadePending;
		this.#cascadePending = false;
		const checks = [...this.#failFastChecks];
		this.#failFastChecks.clear();
		try {
			await this.#session.commitWith(async (tx) => {
				if (this.#closing) return;
				const queued = await this.#loadScopes(cascade);
				const marked = new Set<TaskId>();
				const mark = (record: AnyTaskRecord): void => {
					if (record.abortRequested || marked.has(record.id)) return;
					marked.add(record.id);
					tx.setTask({ ...record, abortRequested: true });
				};
				for (const record of this.#live.values()) {
					if (!record.background && this.#belowCancelled(parentOf(record))) mark(record);
				}
				for (const id of checks) {
					const waiter = this.#live.get(id);
					if (waiter?.state.status !== "waiting" || !(await this.#anyFailed(waiter.state.on)))
						continue;
					for (const member of waiter.state.on) {
						const record = this.#live.get(member);
						if (record !== undefined && !failedOutcome(record)) mark(record);
					}
				}
				for (const id of queued)
					if (this.#belowCancelled({ conversation: id })) await this.#withdrawInputs(tx, id);
				await this.#finalize(tx);
			}, this.#context);
		} catch (error) {
			this.#cascadePending = true;
			for (const id of checks) {
				this.#failFastChecks.add(id);
			}
			if (!this.#closing) this.#report(error);
		}
		this.#resolveIdleWaiters();
	}

	async #anyFailed(ids: readonly TaskId[]): Promise<boolean> {
		for (const id of ids) {
			const record = this.#live.get(id) ?? (await this.#storage.task(id, this.#context));
			if (record !== undefined && failedOutcome(record)) return true;
		}
		return false;
	}

	async #finalize(tx: Transaction): Promise<void> {
		for (;;) {
			const overlay = overlayOf(tx);
			const owned = this.#ownedLive(overlay);
			const done = [...this.#liveRecords(overlay)].filter(
				(record) => record.state.status === "completing" && !owned.has(record.id),
			);
			if (done.length === 0) return;
			for (const record of done) {
				const outcome = (record.state as { readonly outcome: TaskOutcome<JsonValue> }).outcome;
				tx.setTask(withState(record, { status: "terminal", outcome }));
				if (outcome.status === "faulted" || outcome.status === "orphaned") {
					await this.#settleOutcome(tx, record, outcome);
				}
			}
		}
	}

	async #loadScopes(queued: boolean): Promise<ConversationId[]> {
		for (const record of [...this.#live.values()]) {
			if (!this.#chainKnown(parentOf(record))) await this.#loadChain(parentOf(record));
		}
		if (!queued) return [];
		const submissions = await scanAll((cursor) =>
			this.#storage.scanSubmissions({ status: "queued" }, SCAN_PAGE_SIZE, cursor, this.#context),
		);
		const conversations = [
			...new Set(submissions.map((submission) => submission.conversationId)),
		];
		for (const id of conversations) {
			await this.#loadChain({ conversation: id });
		}
		return conversations;
	}

	async #loadChain(start: Up, overlay?: Overlay): Promise<void> {
		let at: Up | undefined = start;
		while (at !== undefined) {
			if ("task" in at) {
				let node = this.#node(at.task, overlay);
				if (node === undefined) {
					const record = await this.#storage.task(at.task, this.#context);
					if (record === undefined) return;
					node = nodeOf(record);
					if (record.state.status === "terminal") this.#settled.set(record.id, node);
				}
				at = parentOf(node);
			} else {
				let edge = this.#edge(at.conversation, overlay);
				if (edge === undefined) {
					const record = await this.#storage.conversation(at.conversation, this.#context);
					edge = record?.owner?.taskId ?? null;
					this.#setEdge(at.conversation, edge);
				}
				at = edge === null ? undefined : { task: edge };
			}
		}
	}

	#setEdge(conversationId: ConversationId, owner: TaskId | null): void {
		this.#edges.set(conversationId, owner);
		if (owner !== null) this.#conversationOwners.add(owner);
	}

	#edge(id: ConversationId, overlay?: Overlay): TaskId | null | undefined {
		return overlay?.edges.has(id) === true ? overlay.edges.get(id) : this.#edges.get(id);
	}

	#node(id: TaskId, overlay?: Overlay): TaskNode | undefined {
		return overlay?.tasks.get(id) ?? this.#live.get(id) ?? this.#settled.get(id);
	}

	*#above(start: Up, overlay?: Overlay): Generator<Step> {
		let at: Up | undefined = start;
		while (at !== undefined) {
			if ("task" in at) {
				const node = this.#node(at.task, overlay);
				if (node === undefined) {
					yield { unknown: true };
					return;
				}
				yield { task: at.task, node };
				at = parentOf(node);
			} else {
				yield { conversation: at.conversation };
				const edge = this.#edge(at.conversation, overlay);
				if (edge === undefined) {
					yield { unknown: true };
					return;
				}
				at = edge === null ? undefined : { task: edge };
			}
		}
	}

	#chainKnown(start: Up, overlay?: Overlay): boolean {
		for (const step of this.#above(start, overlay)) {
			if ("unknown" in step) return false;
		}
		return true;
	}

	*#liveRecords(overlay?: Overlay): Generator<AnyTaskRecord> {
		for (const record of this.#live.values()) {
			const candidate = overlay?.tasks.get(record.id) ?? record;
			if (candidate.state.status !== "terminal") yield candidate;
		}
		if (overlay === undefined) return;
		for (const record of overlay.tasks.values()) {
			if (!this.#live.has(record.id) && record.state.status !== "terminal") yield record;
		}
	}

	#ownedLive(overlay?: Overlay): Map<TaskId, TaskId[]> {
		const owned = new Map<TaskId, TaskId[]>();
		for (const record of this.#liveRecords(overlay)) {
			if (record.background) continue;
			for (const step of this.#above(parentOf(record), overlay)) {
				if ("unknown" in step) break;
				if (!("task" in step)) continue;
				const below = owned.get(step.task);
				if (below === undefined) owned.set(step.task, [record.id]);
				else below.push(record.id);
				if (step.node.background) break;
			}
		}
		return owned;
	}

	#inScope(start: Up, scope: Scope, crossBackground = false): boolean | undefined {
		for (const step of this.#above(start)) {
			if ("unknown" in step) return undefined;
			if ("conversation" in step) {
				if ("conversation" in scope && step.conversation === scope.conversation) return true;
			} else if (step.node.background && !crossBackground) {
				return false;
			}
		}
		return "roots" in scope;
	}

	#belowCancelled(start: Up): boolean {
		for (const step of this.#above(start)) {
			if ("unknown" in step) return false;
			if (!("task" in step)) continue;
			const live = this.#live.get(step.task);
			if (live !== undefined && cancellationIntent(live)) return true;
			if (step.node.background) return false;
		}
		return false;
	}

	#seal(): void {
		this.#closing = true;
		this.#unsubscribeRegistry();
		const error = closedError();
		this.#taskWaiters.rejectAll(error);
		this.#idleWaiters.rejectAll(error);
		for (const invocation of this.#invocations.values()) {
			invocation.controller.abort();
		}
	}

	#kick(): void {
		this.#dirty = true;
		if (this.#draining || !this.#enabled || this.#closing) return;
		this.#draining = true;
		queueMicrotask(() => void this.#drain());
	}

	async #drain(): Promise<void> {
		try {
			while (this.#dirty && this.#enabled && !this.#closing) {
				this.#dirty = false;
				for (const reservation of await this.#reserve()) {
					this.#start(reservation);
				}
			}
		} catch (error) {
			if (!this.#closing) this.#report(error);
		} finally {
			this.#draining = false;
			if (this.#dirty) this.#kick();
		}
	}

	async #reserve(): Promise<Reservation[]> {
		const reservations: Reservation[] = [];
		try {
			await this.#session.commitWith(async (tx) => {
				if (!this.#enabled || this.#closing) return;
				await this.#loadScopes(false);
				const owned = this.#ownedLive();
				let snapshot: RegistrySnapshot | undefined;
				for (const record of [...this.#live.values()]) {
					if (this.#invocations.has(record.id) || this.#waitingOn(record, owned).length > 0)
						continue;
					if (record.state.status === "completing") continue;
					const runnable = record as RunnableTaskRecord;
					const mode = record.abortRequested ? "abort" : "run";
					snapshot ??= this.#registry.snapshot();
					const resolution = this.#resolve(runnable, snapshot);
					if (resolution.kind === "blocked") {
						if (mode === "abort") {
							await this.#terminate(tx, record, {
								status: "orphaned",
								reason: resolution.reason,
							});
						}
						continue;
					}
					if (resolution.record !== runnable || record.state.status !== "running") {
						tx.setTask(
							withState(resolution.record, {
								status: "running",
								checkpoint: resolution.record.state.checkpoint,
							}),
						);
					}
					const invocation = this.#createInvocation(record, mode);
					reservations.push({ invocation, task: resolution.task, snapshot });
				}
			}, this.#context);
		} catch (error) {
			for (const { invocation } of reservations) {
				this.#invocations.delete(invocation.taskId);
				invocation.finish();
			}
			throw error;
		}
		return reservations;
	}

	#waitingOn(
		record: AnyTaskRecord,
		owned: ReadonlyMap<TaskId, readonly TaskId[]>,
	): readonly TaskId[] {
		if (record.abortRequested) return owned.get(record.id) ?? [];
		if (record.state.status !== "waiting") return [];
		return record.state.on.filter((id) => this.#live.has(id));
	}

	#resolve(record: RunnableTaskRecord, snapshot: RegistrySnapshot): Resolution {
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", reason: fit.reason };
		if (!fit.migrates) return { kind: "ready", task: fit.task, record };
		const definition = erased(fit.task);
		try {
			if (definition.migrate === undefined) throw missingMigration(record, definition);
			const migrated = definition.migrate(record.input, record.state.checkpoint, record.version);
			const state = { ...record.state, checkpoint: copyJson(migrated.checkpoint) };
			const migratedRecord = {
				...record,
				version: definition.version,
				input: copyJson(migrated.input),
				state,
			};
			return { kind: "ready", task: fit.task, record: migratedRecord as RunnableTaskRecord };
		} catch (error) {
			this.#failedMigrations.set(record.id, { task: fit.task, error });
			this.#report(error);
			return { kind: "blocked", reason: "migration_failed" };
		}
	}

	#fit(record: AnyTaskRecord, task: AnyTask | undefined): Fit {
		if (task === undefined) return { reason: "missing_task" };
		const version = task.definition.version;
		if (version === record.version) return { task, migrates: false };
		if (version < record.version) return { reason: "task_too_old" };
		const failed = this.#failedMigrations.get(record.id);
		if (failed?.task === task) return { reason: "migration_failed", error: failed.error };
		return { task, migrates: true };
	}

	async inspect(
		snapshot: RegistrySnapshot,
	): Promise<{ scheduling: HarnessInspection["scheduling"]; tasks: TaskInspection[] }> {
		await this.#loadScopes(false);
		const owned = this.#ownedLive();
		const tasks: TaskInspection[] = [];
		for (const record of this.#live.values()) {
			tasks.push({ record, state: this.#inspectTask(record, snapshot, owned) });
		}
		const scheduling = this.#closing ? "closing" : this.#enabled ? "running" : "paused";
		return { scheduling, tasks };
	}

	#inspectTask(
		record: AnyTaskRecord,
		snapshot: RegistrySnapshot,
		owned: ReadonlyMap<TaskId, readonly TaskId[]>,
	): TaskInspection["state"] {
		if (this.#invocations.has(record.id)) return { kind: "running" };
		if (record.state.status === "completing") return { kind: "completing" };
		const on = this.#waitingOn(record, owned);
		if (on.length > 0) return { kind: "waiting", on };
		const fit = this.#fit(record, snapshot.task(record.kind));
		if ("reason" in fit) return { kind: "blocked", ...fit };
		if (fit.migrates && fit.task.definition.migrate === undefined) {
			return {
				kind: "blocked",
				reason: "migration_failed",
				error: missingMigration(record, erased(fit.task)),
			};
		}
		return { kind: "ready", migrates: fit.migrates };
	}

	#createInvocation(record: AnyTaskRecord, mode: "run" | "abort"): Invocation {
		const controller = new AbortController();
		const { promise: done, resolve: finish } = Promise.withResolvers<void>();
		const invocation: Invocation = {
			taskId: record.id,
			conversationId: record.conversationId,
			mode,
			controller,
			context: withAbortSignal(controller.signal, this.#context),
			watches: new Set(),
			ended: false,
			done,
			finish: () => finish(),
		};
		this.#invocations.set(record.id, invocation);
		return invocation;
	}

	#start(reservation: Reservation): void {
		const invocation = reservation.invocation;
		void (async () => {
			try {
				if (invocation.mode === "run") await this.#run(reservation);
				else await this.#runAbort(reservation);
			} catch (error) {
				this.#report(error);
			} finally {
				this.#end(invocation);
				invocation.finish();
				this.#kick();
			}
		})();
	}

	async #run(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const state = {
			task: reservation.task,
			snapshot: reservation.snapshot,
			reported: undefined as ReportedTask,
		};
		const phase: Phase = {
			snapshot: () => state.snapshot,
			task: () => state.task,
			agent: undefined,
		};
		const runtime = this.#runtime(invocation, phase);
		let previous: PhaseResult | undefined;
		for (;;) {
			const current = await this.#step(invocation, (tx, current) =>
				this.#decide(tx, current, previous, state),
			);
			if (current === undefined || this.#closing) return;
			const checkpoint = current.state.checkpoint;
			phase.agent = undefined;
			try {
				await erased(state.task).phases[checkpoint.phase]!(
					current,
					runtime,
					invocation.context,
				);
				previous = { checkpoint };
			} catch (error) {
				previous = { checkpoint, failure: { error } };
			}
		}
	}

	#decide(
		tx: Transaction,
		current: ErasedRunningTask,
		previous: PhaseResult | undefined,
		state: { task: AnyTask; snapshot: RegistrySnapshot; reported: ReportedTask },
	): Decision {
		if (current.abortRequested) return false;
		if (previous === undefined) return true;
		if (previous.failure !== undefined) return { fault: previous.failure.error };
		if (jsonEqual(current.state.checkpoint, previous.checkpoint)) {
			const phase = previous.checkpoint.phase;
			const message = `Task ${current.kind} phase ${phase} returned without durable progress`;
			return { fault: new Error(message) };
		}
		state.snapshot = this.#registry.snapshot();
		const next = state.snapshot.task(current.kind);
		if (next !== state.task) {
			if (next !== undefined && canReserve(next, current)) {
				tx.setTask(
					withState(current, { status: "pending", checkpoint: current.state.checkpoint }),
				);
				return false;
			}
			if (state.reported === undefined || state.reported.task !== next) {
				state.reported = { task: next };
				const cause = next === undefined ? "missing_task" : "incompatible_task";
				this.#report(
					new Error(
						`Task ${current.id} keeps running under its old ${current.kind} definition`,
						{ cause },
					),
				);
			}
		}
		return true;
	}

	async #runAbort(reservation: Reservation): Promise<void> {
		const invocation = reservation.invocation;
		const current = this.#live.get(invocation.taskId) as ErasedRunningTask | undefined;
		if (current === undefined || this.#closing) return;
		let failure: { readonly error: unknown } | undefined;
		try {
			const phase: Phase = {
				snapshot: () => reservation.snapshot,
				task: () => reservation.task,
				agent: undefined,
			};
			const runtime = this.#runtime(invocation, phase);
			await erased(reservation.task).abort(current, runtime, invocation.context);
		} catch (error) {
			failure = { error };
		}
		const message = `Abort handler of task ${invocation.taskId} returned without a terminal outcome`;
		await this.#step(invocation, () => ({ fault: failure?.error ?? new Error(message) }));
	}

	async #step(
		invocation: Invocation,
		decide: (tx: Transaction, current: ErasedRunningTask) => Decision,
	): Promise<ErasedRunningTask | undefined> {
		try {
			return await this.#session.commitWith(async (tx) => {
				const found = this.#live.get(invocation.taskId);
				const current =
					found?.state.status === "running" ? (found as ErasedRunningTask) : undefined;
				const decision = current !== undefined && !this.#closing ? decide(tx, current) : false;
				if (decision === true) return current;
				this.#end(invocation);
				if (decision !== false) {
					const message =
						decision.fault instanceof Error ? decision.fault.message : String(decision.fault);
					await this.#terminate(tx, current!, { status: "faulted", error: { message } });
				}
				return undefined;
			}, this.#context);
		} catch (error) {
			this.#end(invocation);
			if (!this.#closing) this.#report(error);
			return undefined;
		}
	}

	async #terminate(
		tx: Transaction,
		record: AnyTaskRecord,
		outcome: SchedulerOutcome,
	): Promise<void> {
		await this.#loadScopes(false);
		if (this.#ownedLive(overlayOf(tx)).has(record.id)) {
			tx.setTask(withState(record, { status: "completing", outcome }));
			return;
		}
		tx.setTask(withState(record, { status: "terminal", outcome }));
		await this.#settleOutcome(tx, record, outcome);
	}

	async #commitState(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		next: NextTaskState<Checkpoint, JsonValue>,
	): Promise<void> {
		if (next.status === "waiting")
			await this.#validateWait(tx, invocation, current, next.on, next.policy);
		if (next.status === "terminal") {
			const overlay = overlayOf(tx);
			await this.#loadScopes(false);
			for (const record of overlay.tasks.values()) {
				await this.#loadChain(parentOf(record), overlay);
			}
			if (this.#ownedLive(overlay).has(current.id)) {
				tx.setTask(withState(current, { status: "completing", outcome: next.outcome }));
				return;
			}
		}
		tx.setTask(withState(current, next));
	}

	async #validateWait(
		tx: Transaction,
		invocation: Invocation,
		current: ErasedRunningTask,
		on: readonly TaskId[],
		policy: string,
	): Promise<void> {
		if (invocation.mode === "abort")
			throw new Error(`Abort handler of task ${current.id} cannot wait`);
		const overlay = overlayOf(tx);
		await this.#loadChain(parentOf(current));
		const owners = new Set<TaskId>();
		for (const step of this.#above(parentOf(current))) {
			if ("task" in step) owners.add(step.task);
		}
		for (const id of on) {
			if (id === current.id || owners.has(id)) {
				throw new Error(`Task ${current.id} cannot wait on itself or its owner ${id}`);
			}
			const member =
				overlay.tasks.get(id) ??
				this.#live.get(id) ??
				(await this.#storage.task(id, this.#context));
			if (member === undefined) throw new Error(`Task ${id} does not exist`);
			if (policy === "failFast" && member.owner !== current.id) {
				throw new Error(
					`Task ${current.id} can wait failFast only on tasks it owns; ${id} is not one`,
				);
			}
		}
	}

	#end(invocation: Invocation): void {
		if (invocation.ended) return;
		invocation.ended = true;
		if (this.#invocations.get(invocation.taskId) === invocation)
			this.#invocations.delete(invocation.taskId);
		for (const watch of invocation.watches) {
			void watch.stop();
		}
		invocation.controller.abort(endedError(invocation));
	}

	#idle(conversationId: ConversationId | undefined): boolean {
		const scope: Scope =
			conversationId === undefined ? { roots: true } : { conversation: conversationId };
		for (const record of this.#live.values()) {
			if (!record.background && this.#inScope(parentOf(record), scope) !== false) return false;
		}
		return true;
	}

	#runtime(invocation: Invocation, phase: Phase): ErasedRuntime {
		const agent = (): Promise<Agent> => {
			if (invocation.ended) return Promise.reject(endedError(invocation));
			if (phase.agent === undefined) {
				phase.agent = this.#agent(
					invocation.conversationId,
					phase.snapshot(),
					invocation.context,
				);
				phase.agent.catch(() => {});
			}
			return phase.agent;
		};
		const hooks: HookRunner<Record<string, unknown>> = {
			each: async (name, invoke) => {
				for (const handlers of agentHooks(await agent(), phase.task().definition.name)) {
					const handler = (handlers as Record<string, unknown>)[name];
					if (typeof handler !== "function") continue;
					try {
						await invoke(handler.bind(handlers));
					} catch (error) {
						if (invocation.controller.signal.aborted) throw error;
						this.#report(error);
					}
				}
			},
		};
		const settings = this.#settings;
		return {
			taskId: invocation.taskId as TaskId<JsonValue>,
			conversationId: invocation.conversationId,
			signal: invocation.controller.signal,
			models: this.#models,
			agent: (context) =>
				invocation.ended
					? Promise.reject(endedError(invocation))
					: awaitWithContext(agent(), context),
			get settings() {
				return settings();
			},
			env: (context) =>
				this.#read(invocation, () => this.#env(invocation.conversationId, context)),
			hooks: hooks as ErasedRuntime["hooks"],
			get registry() {
				return phase.snapshot();
			},
			commit: (change, context) =>
				this.#gated(
					invocation,
					async (tx, current) => {
						const next = await change(tx, current);
						if (next !== undefined) await this.#commitState(tx, invocation, current, next);
					},
					context,
				),
			memo: ((name: string, ...rest: readonly unknown[]) => {
				if (rest.length === 1) {
					return this.#read(invocation, async () =>
						memoOf(this.#live.get(invocation.taskId), name),
					);
				}
				const candidate = rest[0] as JsonValue;
				return this.#gated(
					invocation,
					(tx, current) => {
						const winner = memoOf(current, name);
						if (winner !== undefined) return winner;
						tx.setTask({
							...current,
							memos: { ...current.memos, [name]: candidate },
						} as AnyTaskRecord);
						return candidate;
					},
					rest[1] as Context,
				);
			}) as ErasedRuntime["memo"],
			sleep: (until, context) => this.#sleep(invocation, until, context),
			watchDoc: ((...args: readonly unknown[]) =>
				this.#watchDoc(invocation, args)) as ErasedRuntime["watchDoc"],
			snapshot: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshot")(...args),
				)) as ErasedRuntime["snapshot"],
			snapshotAsOf: ((...args: readonly unknown[]) =>
				this.#read(invocation, () =>
					sessionMethod(this.#session, "snapshotAsOf")(...args),
				)) as ErasedRuntime["snapshotAsOf"],
			getTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(() => this.#storage.task(id, context)),
				)) as ErasedRuntime["getTask"],
			waitForTask: ((id: TaskId, context: Context) =>
				this.#read(invocation, () =>
					this.waitForTask(id, withAbortSignal(invocation.controller.signal, context)),
				)) as ErasedRuntime["waitForTask"],
			outcomes: ((ids: readonly TaskId[], context: Context) =>
				this.#read(invocation, () =>
					this.#session.readOnLine(async () => {
						const outcomes: TaskOutcome<JsonValue>[] = [];
						for (const id of ids) {
							const state = (await this.#storage.task(id, context))?.state;
							if (state?.status !== "terminal")
								throw new Error(`Task ${id} is not terminal`);
							outcomes.push(state.outcome);
						}
						return outcomes;
					}),
				)) as ErasedRuntime["outcomes"],
			conversation: (id, context) =>
				this.#read(invocation, () =>
					this.#conversation(
						id,
						{
							signal: invocation.controller.signal,
							check: () => {
								if (invocation.ended) throw endedError(invocation);
							},
						},
						context,
					),
				),
			entry: ((...args: readonly unknown[]) => {
				const [token, id, context] =
					args.length === 2
						? [undefined, args[0] as EntryId, args[1] as Context]
						: [args[0] as { readonly kind: string }, args[1] as EntryId, args[2] as Context];
				return this.#read(invocation, async () => {
					const found = await this.#session.readOnLine(() =>
						this.#storage.entry(invocation.conversationId, id, context),
					);
					const entry: EntryRecord | undefined = found?.entry;
					return token === undefined || entry?.kind === token.kind ? entry : undefined;
				});
			}) as ErasedRuntime["entry"],
			context: (conversationId, context, at) =>
				this.#read(invocation, () =>
					readContext(this.#session, this.#storage, conversationId, context, at),
				),
			now: () => {
				if (invocation.ended) throw endedError(invocation);
				return this.#now();
			},
			report: (error) => {
				if (invocation.ended) throw endedError(invocation);
				this.#report(error);
			},
		};
	}

	async #read<T>(invocation: Invocation, read: () => Promise<T>): Promise<T> {
		if (invocation.ended) throw endedError(invocation);
		return read();
	}

	#gated<T>(
		invocation: Invocation,
		change: (tx: Transaction, current: ErasedRunningTask) => T | Promise<T>,
		context: Context,
	): Promise<T> {
		if (invocation.ended) return Promise.reject(endedError(invocation));
		return this.#session.commitWith(
			async (tx) => {
				if (invocation.ended) throw endedError(invocation);
				if (this.#closing) throw closedError();
				const found = this.#live.get(invocation.taskId);
				if (found === undefined) throw new Error(`Task ${invocation.taskId} is terminal`);
				if (found.state.status !== "running")
					throw new Error(`Task ${invocation.taskId} is ${found.state.status}`);
				const current = found as ErasedRunningTask;
				if (invocation.mode === "run" && current.abortRequested) {
					throw new Error(`Task ${invocation.taskId} has a durable abort mark`);
				}
				return change(tx, current);
			},
			context,
			{ conversationId: invocation.conversationId, taskId: invocation.taskId },
		);
	}

	async #sleep(invocation: Invocation, until: number, context: Context): Promise<void> {
		if (invocation.ended) throw endedError(invocation);
		const signals = [invocation.controller.signal];
		if (context.abortSignal !== undefined) signals.push(context.abortSignal);
		const signal = AbortSignal.any(signals);
		for (;;) {
			signal.throwIfAborted();
			const remaining = until - this.#now();
			if (remaining <= 0) return;
			await delay(Math.min(remaining, MAX_TIMER_DELAY), signal);
		}
	}

	async #watchDoc(
		invocation: Invocation,
		args: readonly unknown[],
	): Promise<DocumentWatch<JsonObject> | undefined> {
		if (invocation.ended) throw endedError(invocation);
		const watch = (await sessionMethod(this.#session, "watchDoc")(...args)) as
			| DocumentWatch<JsonObject>
			| undefined;
		if (watch === undefined) return undefined;
		if (invocation.ended) {
			void watch.stop();
			throw endedError(invocation);
		}
		invocation.watches.add(watch);
		void watch.closed.then(() => invocation.watches.delete(watch));
		return watch;
	}
}
