import type { Draft, JsonRepresentation, JsonValue } from "@huranth/chord";
import type { AssistantMessage } from "@huranth/gama-ai";
import { defineDoc } from "../documents.ts";
import type { Transaction } from "../session/transaction.ts";
import type {
	EntryId,
	SubmissionId,
	SubmissionSettlement,
	TaskId,
	TaskRecord,
	Tx,
} from "../types.ts";
import { convertPartial } from "./generation.ts";
import type { SchedulerOutcome } from "./scheduler.ts";
import type { CompactionReason, CompactionResult, ToolDiagnostic } from "./types.ts";

export type ToolSlot = {
	callId: string;
	name: string;
	taskId?: TaskId;
	status: "pending" | "running" | "done";
	output?: string;
	droppedBytes?: number;
	droppedLines?: number;
	details?: JsonValue;
	diagnostics?: ToolDiagnostic[];
	entry?: EntryId;
};

export type CompactionStatus = {
	taskId: TaskId<CompactionResult>;
	reason: CompactionReason;
	blocking: boolean;
	attempt: number;
	retry?: { at: number; error: string };
};

export type LiveState = {
	run?: { taskId: TaskId; inputs: SubmissionId[] };
	generation?: {
		attempt: number;
		message?: JsonRepresentation<AssistantMessage>;
		retry?: { at: number; error: string };
		deferred?: { pollAt: number };
	};
	tools?: ToolSlot[];
	compactions?: CompactionStatus[];
};

export const LiveDoc = defineDoc<LiveState>({
	kind: "gama.live",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: (value) =>
		value.generation === undefined &&
		!(value.tools ?? []).some((slot) => slot.status === "running"),
});

const RUN_TASK_KINDS: ReadonlySet<string> = new Set(["gama.generation"]);
const TOOL_TASK_KIND = "gama.tool";
const COMPACTION_TASK_KIND = "gama.compaction";

export function endRun(
	tx: Tx,
	live: Draft<LiveState>,
	taskId: TaskId,
	settlement: SubmissionSettlement,
): void {
	if (live.run?.taskId === taskId) {
		for (const id of live.run.inputs) {
			tx.settleSubmission(id, settlement);
		}
		delete live.run;
	}
	delete live.generation;
	delete live.tools;
}

export function addCompactionStatus(live: Draft<LiveState>, status: CompactionStatus): void {
	live.compactions ??= [];
	live.compactions.push(status);
}

export function compactionStatus(
	live: Draft<LiveState>,
	taskId: TaskId,
): Draft<CompactionStatus> | undefined {
	return live.compactions?.find((status) => status.taskId === taskId);
}

export function removeCompactionStatus(live: Draft<LiveState>, taskId: TaskId): void {
	const statuses = live.compactions;
	if (statuses === undefined) return;

	const index = statuses.findIndex((status) => status.taskId === taskId);
	if (index >= 0) statuses.splice(index, 1);
	if (statuses.length === 0) delete live.compactions;
}

export function toolSlot(live: Draft<LiveState>, taskId: TaskId): Draft<ToolSlot> | undefined {
	return live.tools?.find((slot) => slot.taskId === taskId);
}

export function finishSlot(slot: Draft<ToolSlot>, entry: EntryId | undefined): void {
	slot.status = "done";
	if (entry !== undefined) slot.entry = entry;
	clearProgress(slot);
}

export function clearProgress(slot: Draft<ToolSlot>): void {
	delete slot.output;
	delete slot.droppedBytes;
	delete slot.droppedLines;
	delete slot.details;
	delete slot.diagnostics;
}

export async function settleSchedulerOutcome(
	tx: Transaction,
	record: TaskRecord<JsonValue, JsonValue, JsonValue>,
	outcome: SchedulerOutcome,
): Promise<void> {
	if (record.kind === TOOL_TASK_KIND) {
		const slot = toolSlot(await tx.doc(LiveDoc, record.conversationId), record.id);
		if (slot !== undefined) finishSlot(slot, undefined);
		return;
	}

	if (record.kind === COMPACTION_TASK_KIND) {
		removeCompactionStatus(await tx.doc(LiveDoc, record.conversationId), record.id);
		return;
	}

	if (!RUN_TASK_KINDS.has(record.kind)) return;

	const live = await tx.doc(LiveDoc, record.conversationId);
	if (live.run?.taskId !== record.id) return;

	await convertPartial(tx, live, record.conversationId);
	endRun(
		tx,
		live,
		record.id,
		outcome.status === "faulted"
			? { status: "unanswered", reason: "faulted", detail: outcome.error.message }
			: { status: "unanswered", reason: outcome.reason },
	);
}
