import type { Context, JsonValue } from "@huranth/chord";
import type { Op, Path } from "@huranth/chord/delta";
import type { AssistantMessage, Message, Usage } from "@huranth/gama-ai";
import { CommittedWatch } from "../session/observation.ts";
import type {
	CommitChange,
	CommitPublication,
	ConversationId,
	EntryRecord,
	JsonObject,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	WatchEnd,
} from "../types.ts";
import { AgentDoc } from "./agent.ts";
import type { InboxItem, InboxState } from "./inbox.ts";
import type { CompactionStatus, LiveState, ToolSlot } from "./live.ts";
import type { AgentState, CompactionReason, Harness, ToolDiagnostic } from "./types.ts";
import { UsageDoc, type UsageState } from "./usage.ts";
import { scanAll } from "./util.ts";
import { type ConversationView, conversationViews } from "./view.ts";

type Block = AssistantMessage["content"][number];

type QueuedItem = { id: SubmissionId; mode: InboxItem["mode"] };

export type MessageChange =
	| {
			type: "text_start" | "thinking_start" | "toolcall_start";
			contentIndex: number;
			block: Block;
	  }
	| { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			path: readonly (string | number)[];
			delta: string;
	  }
	| { type: "block"; contentIndex: number; block: Block }
	| { type: "message"; message: AssistantMessage };

export type SnapshotEvent = {
	type: "snapshot";
	entries: readonly EntryRecord[];
	run?: { inputs: readonly SubmissionId[] };
	generation?: {
		attempt: number;
		message?: AssistantMessage;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools: readonly ToolSlot[];
	compactions: readonly CompactionStatus[];
	inbox: readonly QueuedItem[];
	agent: AgentState;
	usage: UsageState;
};

export type AgentEvent =
	| SnapshotEvent
	| { type: "run_start"; inputs: readonly SubmissionId[] }
	| { type: "run_end"; inputs: readonly SubmissionId[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: Message }
	| { type: "message_update"; usage: Usage; changes: readonly MessageChange[] }
	| { type: "message_end"; entry: EntryRecord }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: JsonObject }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			output?: { trimStart?: number; append?: string } | { set: string };
			details?: JsonValue;
			diagnostics?: readonly ToolDiagnostic[];
	  }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; entry?: EntryRecord }
	| { type: "inbox_update"; items: readonly QueuedItem[] }
	| { type: "submission"; record: SubmissionRecord }
	| { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
	| { type: "auto_retry_end"; attempt: number }
	| { type: "deferred_poll"; pollAt: number }
	| { type: "entry_appended"; entry: EntryRecord }
	| { type: "agent_changed"; agent: AgentState }
	| { type: "usage_changed"; usage: UsageState }
	| { type: "task_failed"; taskId: TaskId; kind: string; message: string }
	| { type: "compaction_start"; taskId: TaskId; reason: CompactionReason; blocking: boolean }
	| { type: "compaction_end"; taskId: TaskId; reason: CompactionReason };

export interface AgentEventStream {
	readonly snapshot: SnapshotEvent;
	start(listener: (events: readonly AgentEvent[], context: Context) => Promise<void>): void;
	stop(): Promise<WatchEnd>;
	readonly closed: Promise<WatchEnd>;
}

type Parts = {
	live: LiveState;
	inbox: InboxState | undefined;
	agent: AgentState | undefined;
	usage: UsageState | undefined;
};

type TaskChange = Extract<CommitChange, { type: "task" }>;

const PARTIAL_PATH = ["docs", "gama.live", "generation", "message"];

function parts(view: ConversationView): Parts {
	return {
		live: (view.docs["gama.live"] ?? {}) as LiveState,
		inbox: view.docs["gama.inbox"] as InboxState | undefined,
		agent: view.docs["gama.agent"] as AgentState | undefined,
		usage: view.docs["gama.usage"] as UsageState | undefined,
	};
}

function queued(inbox: InboxState | undefined): QueuedItem[] {
	return (inbox?.items ?? []).map((item) => ({ id: item.id, mode: item.mode }));
}

function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
	return entries.find((entry) => {
		const message = entry.model?.[0];
		return message?.role === "toolResult" && message.toolCallId === callId;
	});
}

function startsWith(path: Path, prefix: readonly (string | number)[]): boolean {
	if (prefix.length > path.length) return false;
	return prefix.every((segment, index) => path[index] === segment);
}

function snapshotOf(view: ConversationView): SnapshotEvent {
	const { live, inbox, agent, usage } = parts(view);
	return {
		type: "snapshot",
		entries: view.entries,
		...(live.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
		...(live.generation === undefined
			? {}
			: { generation: live.generation as SnapshotEvent["generation"] }),
		tools: live.tools ?? [],
		compactions: live.compactions ?? [],
		inbox: queued(inbox),
		agent: agent ?? AgentDoc.definition.initial(),
		usage: usage ?? UsageDoc.definition.initial(),
	};
}

export async function watchEvents(
	harness: Harness,
	conversationId: ConversationId,
	context: Context,
): Promise<AgentEventStream> {
	let watch!: CommittedWatch<readonly AgentEvent[]>;
	let snapshot!: SnapshotEvent;
	await conversationViews(harness).attach(
		conversationId,
		async (initial, release, storage) => {
			const query = { conversationId, kind: "gama.generation", status: "completing" } as const;
			const completing = await scanAll((cursor) =>
				storage.scanTasks(query, 100, cursor, context),
			);
			const held = new Set<TaskId>(completing.map((record) => record.id));
			let current = initial;
			snapshot = snapshotOf(initial);
			watch = new CommittedWatch<readonly AgentEvent[]>([], release, () => [
				snapshotOf(current),
			]);
			return {
				publication: (before, after, ops, publication, commitContext) => {
					current = after;
					const events = translate(conversationId, before, after, ops, publication, held);
					if (events.length > 0) watch.advance(events, [], commitContext);
				},
				closeSession: () => watch.closeSession(),
			};
		},
		context,
	);
	const signal = context.abortSignal;
	if (signal?.aborted) {
		watch.cancel();
		throw signal.reason;
	}
	if (signal !== undefined) watch.observeCancellation(signal);
	return {
		snapshot,
		start: (listener) =>
			watch.start((events, _ops, deliveryContext) => listener(events, deliveryContext)),
		stop: () => watch.stop(),
		closed: watch.closed,
	};
}

function toolUpdate(
	viewOps: readonly Op[],
	index: number,
	slot: ToolSlot,
	previous: ToolSlot,
):
	| Omit<
			Extract<AgentEvent, { type: "tool_execution_update" }>,
			"type" | "toolCallId" | "toolName"
	  >
	| undefined {
	const outputPath = ["docs", "gama.live", "tools", index, "output"];
	let trimStart = 0;
	let append = "";
	let set = false;
	for (const op of viewOps) {
		if (!startsWith(op[1] as Path, outputPath)) continue;
		if (op[0] === "t") trimStart += op[2];
		else if (op[0] === "a") append += op[2];
		else set = true;
	}
	let output: { trimStart?: number; append?: string } | { set: string } | undefined;
	if (set || (slot.output !== previous.output && trimStart === 0 && append === ""))
		output = { set: slot.output ?? "" };
	else if (trimStart > 0 || append !== "") {
		output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
	}
	const update = {
		...(output === undefined ? {} : { output }),
		...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
		...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
	};
	return Object.keys(update).length === 0 ? undefined : update;
}

function messageChanges(viewOps: readonly Op[], message: AssistantMessage): MessageChange[] {
	const changes: MessageChange[] = [];
	const whole = new Set<number>();
	for (const op of viewOps) {
		const path = op[1] as Path;
		if (!startsWith(path, PARTIAL_PATH)) {
			if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
			continue;
		}
		const rest = path.slice(PARTIAL_PATH.length);
		if (rest[0] === "usage") continue;
		if (rest[0] !== "content") return [{ type: "message", message }];
		if (rest.length === 1) {
			if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
			for (const [offset, block] of (op[4] as unknown as Block[]).entries()) {
				const type =
					block.type === "text"
						? "text_start"
						: block.type === "thinking"
							? "thinking_start"
							: "toolcall_start";
				changes.push({ type, contentIndex: op[2] + offset, block });
			}
			continue;
		}
		const contentIndex = rest[1] as number;
		const field = rest[2];
		if (whole.has(contentIndex)) continue;
		if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) {
			changes.push({
				type: field === "text" ? "text_delta" : "thinking_delta",
				contentIndex,
				delta: op[2],
			});
		} else if (op[0] === "a" && field === "arguments") {
			changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
		} else {
			whole.add(contentIndex);
			changes.push({ type: "block", contentIndex, block: message.content[contentIndex]! });
		}
	}
	return changes;
}

function translate(
	conversationId: ConversationId,
	before: ConversationView,
	after: ConversationView,
	viewOps: readonly Op[],
	publication: CommitPublication,
	held: Set<TaskId>,
): AgentEvent[] {
	const entries: EntryRecord[] = [];
	const tasks = new Map<TaskId, TaskChange["value"]>();
	const submissions: SubmissionRecord[] = [];
	for (const change of publication.changes) {
		if (change.type === "entry" && change.value.conversationId === conversationId)
			entries.push(change.value);
		if (change.type === "task" && change.value.conversationId === conversationId)
			tasks.set(change.value.id, change.value);
		if (change.type === "submission" && change.value.conversationId === conversationId) {
			submissions.push(change.value);
		}
	}
	if (viewOps.length === 0 && entries.length === 0 && tasks.size === 0 && submissions.length === 0)
		return [];
	submissions.sort((a, b) => a.id - b.id);
	const was = parts(before);
	const now = parts(after);
	const events: AgentEvent[] = [];

	const slotsBefore = new Map((was.live.tools ?? []).map((slot) => [slot.callId, slot]));
	const slots = now.live.tools ?? [];
	for (const slot of slots) {
		if (slot.status !== "running" || slotsBefore.get(slot.callId)?.status === "running") continue;
		const checkpoint =
			slot.taskId === undefined ? undefined : tasks.get(slot.taskId)?.state.checkpoint;
		const args = (checkpoint as { arguments?: JsonObject } | undefined)?.arguments ?? {};
		events.push({
			type: "tool_execution_start",
			toolCallId: slot.callId,
			toolName: slot.name,
			args,
		});
	}
	const partialBefore = was.live.generation?.message as AssistantMessage | undefined;
	const partial = now.live.generation?.message as AssistantMessage | undefined;
	if (partial !== undefined && partialBefore === undefined)
		events.push({ type: "message_start", message: partial });
	else if (partial !== undefined && partial !== partialBefore) {
		events.push({
			type: "message_update",
			usage: partial.usage,
			changes: messageChanges(viewOps, partial),
		});
	}
	for (const [index, slot] of slots.entries()) {
		const previous = slotsBefore.get(slot.callId);
		if (slot.status !== "running" || previous?.status !== "running") continue;
		const update = toolUpdate(viewOps, index, slot, previous);
		if (update === undefined) continue;
		events.push({
			type: "tool_execution_update",
			toolCallId: slot.callId,
			toolName: slot.name,
			...update,
		});
	}
	const generation = now.live.generation;
	const generationBefore = was.live.generation;
	if (generation?.retry !== undefined && generationBefore?.retry === undefined) {
		const { at, error } = generation.retry;
		events.push({
			type: "auto_retry_start",
			attempt: generation.attempt,
			at,
			errorMessage: error,
		});
	}
	if (generationBefore?.retry !== undefined && generation?.retry === undefined) {
		events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
	}
	if (
		generation?.deferred !== undefined &&
		generation.deferred.pollAt !== generationBefore?.deferred?.pollAt
	) {
		events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
	}

	const toolEnds: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
	const endTool = (callId: string, name: string, entryId: number | undefined): void => {
		const entry = entries.find((candidate) => candidate.id === entryId);
		toolEnds.push({
			type: "tool_execution_end",
			toolCallId: callId,
			toolName: name,
			...(entry === undefined ? {} : { entry }),
		});
	};
	for (const previous of slotsBefore.values()) {
		if (previous.status === "done") continue;
		const slot = slots.find((candidate) => candidate.callId === previous.callId);
		if (slot?.status === "done") endTool(previous.callId, previous.name, slot.entry);
		else if (slot === undefined)
			endTool(previous.callId, previous.name, resultOf(entries, previous.callId)?.id);
	}
	for (const slot of slots) {
		if (slot.status === "done" && !slotsBefore.has(slot.callId))
			endTool(slot.callId, slot.name, slot.entry);
	}

	let assistantAppended = false;
	for (const entry of entries) {
		events.push(...toolEnds.filter((end) => end.entry === entry));
		const message = entry.model?.[0];
		if (message === undefined) {
			events.push({ type: "entry_appended", entry });
			continue;
		}
		const streamed =
			message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
		if (message.role === "assistant") assistantAppended = true;
		if (!streamed) events.push({ type: "message_start", message });
		events.push({ type: "message_end", entry });
	}
	events.push(...toolEnds.filter((end) => end.entry === undefined));

	const compactionsBefore = was.live.compactions ?? [];
	const compactions = now.live.compactions ?? [];
	for (const { taskId, reason } of compactionsBefore) {
		if (!compactions.some((status) => status.taskId === taskId)) {
			events.push({ type: "compaction_end", taskId, reason });
		}
	}
	let turnEnded = false;
	for (const task of tasks.values()) {
		const status = task.state.status;
		if (task.kind === "gama.generation" && status === "completing" && !held.has(task.id)) {
			held.add(task.id);
			turnEnded = true;
		}
		if (status !== "terminal") continue;
		if (task.kind === "gama.generation" && !held.delete(task.id)) turnEnded = true;
		const outcome = task.state.outcome;
		if (outcome.status === "faulted" || outcome.status === "orphaned") {
			const message = outcome.status === "faulted" ? outcome.error.message : outcome.reason;
			events.push({ type: "task_failed", taskId: task.id, kind: task.kind, message });
		}
	}
	if (turnEnded) events.push({ type: "turn_end" });
	const run = now.live.run;
	const runBefore = was.live.run;
	const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
	if (runBefore !== undefined && runChanged)
		events.push({ type: "run_end", inputs: runBefore.inputs });

	for (const record of submissions) {
		events.push({ type: "submission", record });
	}
	if (now.inbox !== was.inbox) events.push({ type: "inbox_update", items: queued(now.inbox) });
	if (now.agent !== was.agent) {
		events.push({ type: "agent_changed", agent: now.agent ?? AgentDoc.definition.initial() });
	}
	if (now.usage !== was.usage)
		events.push({ type: "usage_changed", usage: now.usage ?? UsageDoc.definition.initial() });
	for (const { taskId, reason, blocking } of compactions) {
		if (!compactionsBefore.some((status) => status.taskId === taskId)) {
			events.push({ type: "compaction_start", taskId, reason, blocking });
		}
	}
	if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
	if (
		run !== undefined &&
		run.taskId !== runBefore?.taskId &&
		tasks.get(run.taskId)?.kind === "gama.generation"
	) {
		events.push({ type: "turn_start" });
	}
	return events;
}
