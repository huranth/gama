import { type Context, copyJson, type Draft, type JsonValue } from "@huranth/chord";
import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	Message,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
	ToolCall,
} from "@huranth/gama-ai";
import { isContextOverflow } from "@huranth/gama-ai/utils/overflow";
import { isRetryableAssistantError, retryDelayMs } from "@huranth/gama-ai/utils/retry";
import { getCurrentTools } from "@huranth/gama-ai/utils/transcript";
import { AssistantEntry, ResetEntry, SystemEntry, UserEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { defineTask } from "../tasks.ts";
import type {
	ConversationId,
	EntryId,
	NextTaskState,
	SubmissionId,
	TaskId,
	TaskRuntime,
	Tx,
	TypedEntry,
} from "../types.ts";
import { addTools } from "./agent.ts";
import { createCompaction, estimateContext, selectCut } from "./compaction.ts";
import { applyBoundary, prepareBoundary } from "./inbox.ts";
import { assignJson } from "./json.ts";
import { endRun, LiveDoc, type LiveState, type ToolSlot } from "./live.ts";
import { planSystemEntries, renderSections, replaySections } from "./prompt.ts";
import { appendToolResult, harnessError, ToolTask, type ToolTaskResult } from "./tool.ts";
import type {
	CompactionPolicy,
	CompactionResult,
	ContextView,
	ConversationStreamOptions,
	GenerationHooks,
	ModelRef,
	PromptInput,
	ToolControl,
	UserInput,
} from "./types.ts";
import { recordUsage } from "./usage.ts";

export type GenerationInput = Record<string, never>;

export type GenerationCheckpoint =
	| {
			phase: "prepare";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			overflow?: string;
	  }
	| {
			phase: "request";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			thinkingLevel: ModelThinkingLevel;
			streamOptions: ConversationStreamOptions;
			cutoff: EntryId;
	  }
	| { phase: "retry"; attempt: number; compacted?: TaskId<CompactionResult>; until: number }
	| {
			phase: "poll";
			attempt: number;
			compacted?: TaskId<CompactionResult>;
			model: ModelRef;
			cutoff: EntryId;
			handle: DeferredHandle;
			pollAt: number;
	  }
	| {
			phase: "tools";
			assistant: EntryId;
			tools: TaskId<ToolTaskResult>[];
			pending: string[];
	  };

export type GenerationResult = { entryId: EntryId };

type Runtime = TaskRuntime<
	GenerationInput,
	GenerationCheckpoint,
	GenerationResult,
	GenerationHooks
>;

type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;

type Request = {
	readonly attempt: number;
	readonly compacted: TaskId<CompactionResult> | undefined;
	readonly model: ModelRef;
	readonly cutoff: EntryId;
	readonly messages?: readonly Message[];
	readonly pollAt?: number;
};

const PARTIAL_THROTTLE_MS = 100;
const DEFAULT_POLL_AFTER_MS = 5000;

export function handOver(live: Draft<LiveState>, from: TaskId, to: TaskId): void {
	if (live.run?.taskId === from) live.run.taskId = to;
}

async function readCalls(
	runtime: Runtime,
	assistant: EntryId,
	callIds: readonly string[],
	context: Context,
): Promise<ToolCall[]> {
	const message = (await runtime.entry(AssistantEntry, assistant, context))?.model?.[0];
	const calls =
		message?.role === "assistant"
			? message.content.filter((content) => content.type === "toolCall")
			: [];
	return callIds.flatMap((id) => calls.filter((call) => call.id === id).slice(0, 1));
}

function createToolTask(
	tx: Tx,
	runtime: Runtime,
	assistant: EntryId,
	callId: string,
): Promise<TaskId<ToolTaskResult>> {
	return tx.createTask(
		ToolTask,
		{ assistant, callId },
		{ ownership: { kind: "task", taskId: runtime.taskId } },
	);
}

async function failModelError(runtime: Runtime, text: string, context: Context): Promise<void> {
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		endRun(tx, live, runtime.taskId, {
			status: "unanswered",
			reason: "model_error",
			detail: text,
		});
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

async function failNoModel(
	runtime: Runtime,
	ref: ModelRef | undefined,
	context: Context,
): Promise<void> {
	const message =
		ref === undefined
			? "No model is configured"
			: `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "no_model" });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } },
		};
	}, context);
}

async function appendAssistant(
	tx: Tx,
	conversationId: ConversationId,
	message: AssistantMessage,
): Promise<TypedEntry<never>> {
	await recordUsage(
		tx,
		conversationId,
		"models",
		`${message.provider}/${message.model}`,
		message.usage,
	);
	return tx.appendEntry(AssistantEntry, conversationId, { model: [message] });
}

function createGeneration(
	tx: Tx,
	conversationId: ConversationId,
): Promise<TaskId<GenerationResult>> {
	return tx.createTask(
		GenerationTask,
		{},
		{ ownership: { kind: "conversation" }, conversationId },
	);
}

export async function startRun(
	tx: Tx,
	conversationId: ConversationId,
	live: Draft<LiveState>,
	inputs: SubmissionId[],
): Promise<void> {
	live.run = { taskId: await createGeneration(tx, conversationId), inputs };
}

export async function convertPartial(
	tx: Tx,
	live: Draft<LiveState>,
	conversationId: ConversationId,
): Promise<void> {
	const partial = live.generation?.message;
	if (partial === undefined) return;
	const message = copyJson(partial) as unknown as AssistantMessage;
	await appendAssistant(tx, conversationId, { ...message, stopReason: "aborted" });
}

function thresholdCompaction(
	view: ContextView,
	planned: readonly { readonly model?: readonly Message[] }[],
	contextWindow: number,
	policy: CompactionPolicy,
): "blocking" | "background" | undefined {
	if (!policy.enabled || contextWindow <= 0) return undefined;
	const tokens = estimateContext(
		view,
		planned.flatMap((entry) => entry.model ?? []),
	);
	const blocking = contextWindow - policy.reserveTokens;
	const background = blocking - policy.backgroundTokens;

	const over =
		tokens > blocking
			? "blocking"
			: policy.backgroundTokens > 0 && tokens > background
				? "background"
				: undefined;
	if (over === undefined || selectCut(view, policy.keepRecentTokens) === undefined) {
		return undefined;
	}

	return over;
}

async function answer(
	runtime: Runtime,
	message: AssistantMessage,
	context: Context,
): Promise<void> {
	let continuation: UserInput | undefined;
	await runtime.hooks.each("onYield", async (hook) => {
		if (continuation !== undefined) return;
		continuation = (await hook(message, runtime, context))?.continue;
	});
	const conversationId = runtime.conversationId;
	await runtime.commit(async (tx): Promise<Next> => {
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const result: Next = {
			status: "terminal",
			outcome: { status: "completed", result: { entryId: entry.id } },
		};
		const { users, reset } = await applyBoundary(tx, boundary, "final", runtime.now());
		if (continuation !== undefined && users.length === 0 && !reset) {
			const user = { role: "user", content: continuation, timestamp: runtime.now() } as const;
			await tx.appendEntry(UserEntry, conversationId, { model: [user] });
			handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			delete live.generation;
			return result;
		}
		endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
		if (users.length > 0) await startRun(tx, conversationId, live, users);
		return result;
	}, context);
}

async function startToolRound(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	calls: readonly ToolCall[],
	context: Context,
): Promise<void> {
	const conversationId = runtime.conversationId;
	const messages =
		request.messages ?? (await runtime.context(conversationId, context, request.cutoff)).messages;
	const offered = new Set(getCurrentTools(messages).map((tool) => tool.name));
	const tools = (await runtime.agent(context)).tools;

	const sequential =
		runtime.settings.toolExecution === "sequential" ||
		calls.some(
			(call) =>
				offered.has(call.name) &&
				tools.find((tool) => tool.name === call.name)?.executionMode === "sequential",
		);

	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await appendAssistant(tx, conversationId, message);
		const slots: ToolSlot[] = [];
		const tools: TaskId<ToolTaskResult>[] = [];
		const pending: string[] = [];
		for (const call of calls) {
			if (!offered.has(call.name)) {
				const unavailable = harnessError(
					"tool_unavailable",
					`Tool ${call.name} is not available`,
				);
				const result = await appendToolResult(
					tx,
					conversationId,
					call,
					unavailable,
					runtime.now(),
				);
				slots.push({ callId: call.id, name: call.name, status: "done", entry: result.id });
				continue;
			}
			if (sequential && tools.length > 0) {
				pending.push(call.id);
				slots.push({ callId: call.id, name: call.name, status: "pending" });
				continue;
			}
			const taskId = await createToolTask(tx, runtime, entry.id, call.id);
			tools.push(taskId);
			slots.push({ callId: call.id, name: call.name, taskId, status: "pending" });
		}
		delete live.generation;
		live.tools = slots;
		const checkpoint = { phase: "tools", assistant: entry.id, tools, pending } as const;
		return { status: "waiting", checkpoint, on: tools, policy: "allSettled" };
	}, context);
}

async function streamResponse(
	runtime: Runtime,
	model: Model<Api>,
	messages: readonly Message[],
	options: SimpleStreamOptions,
	attempt: number,
	context: Context,
): Promise<AssistantMessage> {
	let pending: AssistantMessage | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let stopped = false;
	const flush = (): void => {
		timer = undefined;
		const partial = pending;
		pending = undefined;
		if (partial === undefined || stopped) return;
		inFlight = (async () => {
			const message = copyJson(partial, { omitUndefinedProperties: true });
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				live.generation ??= { attempt };
				assignJson(live.generation as Draft<Record<string, JsonValue>>, "message", message);
				return undefined;
			}, context);
		})()
			.catch((error: unknown) => {
				if (!runtime.signal.aborted) runtime.report(error);
			})
			.finally(() => {
				inFlight = undefined;
				if (pending !== undefined && !stopped) timer = setTimeout(flush, PARTIAL_THROTTLE_MS);
			});
	};

	try {
		const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
		for await (const event of events) {
			if (event.type === "done" || event.type === "error" || event.partial.content.length === 0)
				continue;
			pending = event.partial;
			if (timer === undefined && inFlight === undefined)
				timer = setTimeout(flush, PARTIAL_THROTTLE_MS);
		}
		return await events.result();
	} finally {
		stopped = true;
		clearTimeout(timer);
		await inFlight;
	}
}

async function finishToolRound(
	runtime: Runtime,
	assistant: EntryId,
	tools: readonly TaskId<ToolTaskResult>[],
	context: Context,
): Promise<void> {
	const conversationId = runtime.conversationId;
	const controls = new Map<TaskId, ToolControl | undefined>();
	const outcomes = await runtime.outcomes(tools, context);
	tools.forEach((id, index) => {
		const outcome = outcomes[index]!;
		controls.set(id, outcome.status === "completed" ? outcome.result.control : undefined);
	});

	const slots = (await runtime.snapshot(LiveDoc, conversationId, context))?.tools ?? [];
	const results = slots.flatMap((slot) => (slot.entry === undefined ? [] : [slot.entry]));
	await runtime.hooks.each("afterTools", (hook) => hook(assistant, results, runtime, context));

	const terminate =
		slots.length > 0 &&
		slots.every(
			(slot) => slot.taskId !== undefined && controls.get(slot.taskId)?.terminate === true,
		);
	const added = [...controls.values()].flatMap((control) => control?.addTools ?? []);
	const handoff = [...controls.values()].findLast(
		(control) => control?.handoff !== undefined,
	)?.handoff;

	await runtime.commit(async (tx): Promise<Next> => {
		const boundary = await prepareBoundary(tx, conversationId, runtime.settings);
		if (added.length > 0) await addTools(tx, conversationId, added);
		const live = await tx.doc(LiveDoc, conversationId);
		const now = runtime.now();
		if (terminate || handoff !== undefined) {
			if (handoff !== undefined) {
				const message = { role: "user", content: handoff, timestamp: now } as const;
				const entry = await tx.appendEntry(ResetEntry, conversationId, {
					head: "self",
					model: [message],
				});
				boundary.head = entry.id;
			}
			const { users } = await applyBoundary(tx, boundary, "final", now);
			endRun(tx, live, runtime.taskId, { status: "done", answer: assistant });
			if (users.length > 0) await startRun(tx, conversationId, live, users);
		} else {
			const { users, reset } = await applyBoundary(tx, boundary, "postTools", now);
			if (reset) {
				endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "reset" });
				if (users.length > 0) await startRun(tx, conversationId, live, users);
			} else {
				delete live.tools;
				if (live.run?.taskId === runtime.taskId) live.run.inputs.push(...users);
				handOver(live, runtime.taskId, await createGeneration(tx, conversationId));
			}
		}
		return {
			status: "terminal",
			outcome: { status: "completed", result: { entryId: assistant } },
		};
	}, context);
}

async function classify(
	runtime: Runtime,
	request: Request,
	message: AssistantMessage,
	context: Context,
): Promise<void> {
	runtime.signal.throwIfAborted();
	const conversationId = runtime.conversationId;
	const { attempt, compacted, model: ref, cutoff } = request;

	if (message.stopReason === "deferred" && message.deferred !== undefined) {
		const handle = message.deferred;
		const pollAt = Math.max(
			runtime.now() + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
			request.pollAt === undefined ? Number.NEGATIVE_INFINITY : request.pollAt + 1,
		);
		await runtime.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).generation = { attempt, deferred: { pollAt } };
			const checkpoint = {
				phase: "poll",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				model: ref,
				cutoff,
				handle,
				pollAt,
			} as const;
			return { status: "running", checkpoint };
		}, context);
		return;
	}

	await runtime.hooks.each("afterResponse", (hook) => hook(message, runtime, context));

	const calls = message.content.filter(
		(content): content is ToolCall => content.type === "toolCall",
	);
	if (message.stopReason === "toolUse" && calls.length > 0) {
		return startToolRound(runtime, request, message, calls, context);
	}
	if (
		message.stopReason === "stop" ||
		message.stopReason === "length" ||
		message.stopReason === "toolUse"
	) {
		return answer(runtime, message, context);
	}
	const settings = runtime.settings;
	const overflow = message.stopReason === "error" && isContextOverflow(message);

	if (overflow && compacted === undefined && settings.compaction.enabled) {
		const policy = settings.compaction;
		const view = await runtime.context(conversationId, context, cutoff);
		if (selectCut(view, policy.keepRecentTokens) !== undefined) {
			const text = message.errorMessage ?? "Context overflow";
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, conversationId);
				await appendAssistant(tx, conversationId, message);
				delete live.generation;
				const child = await createCompaction(
					tx,
					conversationId,
					{ reason: "overflow" },
					runtime.taskId,
				);
				const checkpoint = {
					phase: "prepare",
					attempt,
					compacted: child,
					overflow: text,
				} as const;
				return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
			}, context);
			return;
		}
	}
	const policy = settings.retry;
	const retry =
		message.stopReason === "error" &&
		!overflow &&
		isRetryableAssistantError(message) &&
		policy.enabled &&
		attempt <= policy.maxRetries;
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;

	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		await appendAssistant(tx, conversationId, message);
		if (retry) {
			live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } };
			const checkpoint = {
				phase: "retry",
				attempt,
				...(compacted === undefined ? {} : { compacted }),
				until,
			} as const;
			return { status: "running", checkpoint };
		}
		const text =
			message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
		endRun(tx, live, runtime.taskId, {
			status: "unanswered",
			reason: "model_error",
			detail: text,
		});
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

export const GenerationTask = defineTask<
	GenerationInput,
	GenerationCheckpoint,
	GenerationResult,
	GenerationHooks
>({
	name: "gama.generation",
	version: 1,
	initial: () => ({ phase: "prepare", attempt: 1 }),
	phases: {
		prepare: async (task, runtime, context) => {
			const { conversationId } = runtime;
			const agent = await runtime.agent(context);
			const settings = runtime.settings;
			const { model, thinkingLevel } = agent;
			const resolved =
				model === undefined
					? undefined
					: runtime.models.getModel(model.provider, model.modelId);
			if (model === undefined || resolved === undefined)
				return failNoModel(runtime, model, context);
			const { attempt, compacted, overflow } = task.state.checkpoint;
			if (compacted !== undefined && overflow !== undefined) {
				const [outcome] = await runtime.outcomes([compacted], context);
				if (outcome?.status !== "completed" || outcome.result.entryId === undefined) {
					return failModelError(runtime, overflow, context);
				}
			}
			const view = await runtime.context(conversationId, context);
			const shown = replaySections(view.messages);
			const report = (error: unknown) => runtime.report(error);
			let env: ExecutionEnv | undefined;
			try {
				env = await runtime.env(context);
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				report(error);
			}
			const input: PromptInput = {
				conversationId,
				agent,
				env,
				shown: Object.fromEntries(shown),
				read: runtime,
			};
			const desired = await renderSections(agent.sections, input, shown, report, context);
			const entries = planSystemEntries(view, desired, agent.tools, runtime.now());
			const threshold =
				compacted === undefined
					? thresholdCompaction(view, entries, resolved.contextWindow, settings.compaction)
					: undefined;
			if (threshold === "blocking") {
				await runtime.commit(async (tx): Promise<Next> => {
					const child = await createCompaction(
						tx,
						conversationId,
						{ reason: "threshold" },
						runtime.taskId,
					);
					const checkpoint = { phase: "prepare", attempt, compacted: child } as const;
					return { status: "waiting", checkpoint, on: [child], policy: "allSettled" };
				}, context);
				return;
			}
			await runtime.commit(async (tx) => {
				let cutoff = (await tx.scanEntries({ conversationId }, 1)).items[0]?.id;
				for (const entry of entries)
					cutoff = (await tx.appendEntry(SystemEntry, conversationId, entry)).id;
				if (cutoff === undefined)
					throw new Error(`Conversation ${conversationId} has no entries to send`);
				if (
					threshold === "background" &&
					(await tx.doc(LiveDoc, conversationId)).compactions === undefined
				) {
					await createCompaction(tx, conversationId, { reason: "threshold" });
				}
				const request = {
					attempt,
					...(compacted === undefined ? {} : { compacted }),
					model,
					thinkingLevel,
					streamOptions: settings.stream,
					cutoff,
				};
				return { status: "running", checkpoint: { phase: "request", ...request } };
			}, context);
		},
		request: async (task, runtime, context) => {
			const {
				attempt,
				compacted,
				model: ref,
				thinkingLevel,
				streamOptions,
				cutoff,
			} = task.state.checkpoint;
			const conversationId = runtime.conversationId;
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				await convertPartial(tx, live, conversationId);
				live.generation = { attempt };
				return undefined;
			}, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			const view = await runtime.context(conversationId, context, cutoff);
			let messages = view.messages;
			await runtime.hooks.each("beforeRequest", async (hook) => {
				const replaced = await hook({ messages }, runtime, context);
				if (replaced !== undefined) messages = replaced.messages;
			});
			const options: SimpleStreamOptions = {
				...streamOptions,
				signal: runtime.signal,
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const message = await streamResponse(runtime, model, messages, options, attempt, context);
			const request = { attempt, compacted, model: ref, cutoff, messages: view.messages };
			await classify(runtime, request, message, context);
		},
		retry: async (task, runtime, context) => {
			const { attempt, compacted, until } = task.state.checkpoint;
			await runtime.sleep(until, context);
			await runtime.commit(async (tx) => {
				(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: attempt + 1 };
				const checkpoint: GenerationCheckpoint = {
					phase: "prepare",
					attempt: attempt + 1,
					...(compacted === undefined ? {} : { compacted }),
				};
				return { status: "running", checkpoint };
			}, context);
		},
		poll: async (task, runtime, context) => {
			const { attempt, compacted, model: ref, cutoff, handle, pollAt } = task.state.checkpoint;
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			await runtime.sleep(pollAt, context);
			const message = await runtime.models.fetchDeferred(model, handle, {
				signal: runtime.signal,
			});
			const request = { attempt, compacted, model: ref, cutoff, pollAt };
			await classify(runtime, request, message, context);
		},
		tools: async (task, runtime, context) => {
			const { assistant, tools, pending } = task.state.checkpoint;
			const [next, ...rest] = pending;
			if (next === undefined) return finishToolRound(runtime, assistant, tools, context);
			await runtime.commit(async (tx): Promise<Next> => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				const taskId = await createToolTask(tx, runtime, assistant, next);
				const slot = live.tools?.find(
					(slot) => slot.callId === next && slot.taskId === undefined,
				);
				if (slot !== undefined) slot.taskId = taskId;
				const checkpoint: GenerationCheckpoint = {
					phase: "tools",
					assistant,
					tools: [...tools, taskId],
					pending: rest,
				};
				return { status: "waiting", checkpoint, on: [taskId], policy: "allSettled" };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		const checkpoint = task.state.checkpoint;
		if (checkpoint.phase === "poll") {
			const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
			if (model !== undefined) {
				try {
					await runtime.models.cancelDeferred(model, checkpoint.handle, {
						signal: runtime.signal,
					});
				} catch (error) {
					runtime.report(error);
				}
			}
		}
		const conversationId = runtime.conversationId;
		const unstarted =
			checkpoint.phase === "tools"
				? await readCalls(runtime, checkpoint.assistant, checkpoint.pending, context)
				: [];
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			await convertPartial(tx, live, conversationId);
			for (const call of unstarted) {
				const result = harnessError("aborted", `Tool ${call.name} was aborted`);
				await appendToolResult(tx, conversationId, call, result, runtime.now());
			}
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});
