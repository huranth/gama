import type { Context, Draft } from "@huranth/chord";
import { type AssistantMessage, type Models, type ToolCall, Type } from "@huranth/gama-ai";
import {
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	GenerationTask,
	Harness,
	type HarnessSettings,
	type HookApi,
	hook,
	LiveDoc,
	type LiveState,
	type Session,
	type Storage,
	section,
	type TaskId,
	type ToolExecutionApi,
	ToolTask,
	type Tx,
	type UserInput,
	wrapTool,
} from "@huranth/gama-durable";
import { expect, expectTypeOf, it } from "vitest";
import type { ExecutionEnv } from "../src/env/index.ts";
import { CodingTools, createBashTool, createEditTool, createReadTool } from "../src/tools/index.ts";

declare const context: Context;
declare const storage: Storage;
declare const models: Models;
declare const session: Session;
declare const conversationId: ConversationId;
declare const message: { readonly kind: string };
declare const haiku: { readonly provider: string; readonly modelId: string };
declare const sonnet: { readonly provider: string; readonly modelId: string };
declare const worktree: string;
declare const name: string;
declare function localEnv(cwd: string): ExecutionEnv;
declare const containers: {
	env(image: string, cwd: string, context: Context): Promise<ExecutionEnv>;
};
declare function renderAgentsMd(): string | undefined;
declare function renderSkills(): string | undefined;
declare function isDangerous(call: ToolCall): boolean;
declare function writes(call: ToolCall): boolean;
declare function requestSecondPass(
	answer: AssistantMessage,
	api: HookApi,
	context: Context,
): Promise<{ readonly continue: UserInput } | undefined>;
declare const metrics: { record(name: string, ms: number): void };
declare function answerText(
	api: ToolExecutionApi,
	entry: EntryId,
	context: Context,
): Promise<string>;
declare const payments: {
	charge(key: string): Promise<{ id: string }>;
	cancel(checkpoint: { phase: string }): Promise<void>;
};
declare function newKey(): string;
declare function receiptEntry(receipt: { id: string }): { kind: string; data: { id: string } };
interface SettingsManager {
	get(key: "timeoutMs"): number;
	get(key: "autoCompact"): boolean;
	set(key: "autoCompact", value: boolean): void;
}
declare const manager: SettingsManager;
declare const Anchor: ReturnType<typeof defineTask<null, { phase: "hold" }, null>>;
declare const Reporter: ReturnType<typeof defineTask<null, { phase: "report" }, null>>;
declare const subagentTool: ReturnType<typeof createReadTool>;

function examples() {
	const readTool = createReadTool();
	const editTool = createEditTool();
	const bashTool = createBashTool();

	const ContextFiles = defineExtension({
		name: "context-files",
		sections: [section("agents-md", renderAgentsMd)],
	});
	const Skills = defineExtension({ name: "skills", sections: [section("skills", renderSkills)] });
	const SkillsV2 = defineExtension({
		name: "skills",
		sections: [section("skills", renderSkills)],
	});
	const Coding = defineExtension({
		name: "coding",
		sections: [
			section("preamble", () => "You are an expert coding assistant.", { tag: false }),
			section("cwd", (input) => input.env && `Working directory: ${input.env.cwd}`),
		],
	});
	const Permissions = defineExtension({
		name: "permissions",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call) =>
					isDangerous(call) ? { block: "Needs approval" } : undefined,
			}),
		],
	});
	const Reviewer = defineExtension({
		name: "reviewer",
		sections: [
			section("role", () => "You review diffs. Report problems as a list. Never edit files."),
		],
		hooks: [hook(GenerationTask, { onYield: requestSecondPass })],
	});

	const Timing = defineExtension({
		name: "timing",
		wraps: [
			wrapTool(bashTool, (tool) => ({
				...tool,
				execute: async (args, api, context) => {
					const start = Date.now();
					try {
						return await tool.execute(args, api, context);
					} finally {
						metrics.record("bash", Date.now() - start);
					}
				},
			})),
		],
	});
	const Venv = defineExtension({
		name: "venv",
		tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
	});

	const PlanModeDoc = defineDoc<{ enabled: boolean }>({
		kind: "app.plan-mode",
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "current",
		initial: () => ({ enabled: false }),
	});
	const PlanMode = defineExtension({
		name: "plan-mode",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) =>
					(await api.snapshot(PlanModeDoc, api.conversationId, context))?.enabled &&
					writes(call)
						? { block: "Plan mode: read-only" }
						: undefined,
			}),
		],
	});

	const Subagent = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description: "Delegate a self-contained task to a subagent and get its answer back.",
				parameters: Type.Object({ task: Type.String() }),
				replay: "safe",
				execute: async (args, api, context) => {
					const { task } = args;
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1))
							.items[0];
						if (existing !== undefined) return existing.id;
						const created = await tx.createConversation({
							ownership: { kind: "task", taskId: api.taskId },
						});
						await configure(tx, created.id, { extensions: { remove: [Subagent] } });
						return created.id;
					}, context);
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					const request = {
						type: "input",
						content: task,
						requestId: `subagent:${api.taskId}`,
					} as const;
					const settled = await (await handle.submit(request, context)).wait(context);
					if (settled.status !== "done" || settled.type !== "input")
						throw new Error(`Subagent failed: ${settled.status}`);
					return {
						content: [{ type: "text", text: await answerText(api, settled.answer, context) }],
					};
				},
			}),
		],
	});

	const SubagentTools = defineExtension({
		name: "subagent-tools",
		tasks: [Anchor, Reporter],
		tools: [subagentTool],
	});

	const Chat = defineExtension({
		name: "chat",
		sections: [section("preamble", () => "You are a helpful assistant.", { tag: false })],
	});

	type Charge = { phase: "prepare" } | { phase: "charge"; key: string };
	const Payment = defineTask<null, Charge, { entryId: EntryId }>({
		name: "app.payment",
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "charge", key: newKey() } }),
					context,
				);
			},
			charge: async (task, runtime, context) => {
				const receipt = await payments.charge(task.state.checkpoint.key);
				await runtime.commit(async (tx, current) => {
					const entry = await tx.appendEntry(current.conversationId, receiptEntry(receipt));
					return {
						status: "terminal",
						outcome: { status: "completed", result: { entryId: entry.id } },
					};
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await payments.cancel(task.state.checkpoint);
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted", reason: "user" } }),
				context,
			);
		},
	});

	const Follow = defineTask<object, { phase: "follow" }, null>({
		name: "app.follow",
		version: 1,
		initial: () => ({ phase: "follow" }),
		phases: { follow: async () => {} },
		abort: async () => {},
	});

	const sequences = {
		childInToolCommit: async (tx: Tx, api: { readonly taskId: TaskId }) => {
			const child = await tx.createConversation({
				ownership: { kind: "task", taskId: api.taskId },
			});
			await configure(tx, child.id, { model: haiku, tools: [readTool], cwd: worktree });
		},

		liveSettings: () => {
			class UserSettings implements HarnessSettings {
				readonly manager: SettingsManager;
				constructor(manager: SettingsManager) {
					this.manager = manager;
				}
				get stream() {
					return { timeoutMs: this.manager.get("timeoutMs") };
				}
				get compaction() {
					return { enabled: this.manager.get("autoCompact") };
				}
			}
			manager.set("autoCompact", false);
			return new UserSettings(manager);
		},

		containerEnv: async () => {
			const registry = createRegistry();
			const ContainerDoc = defineDoc<{ image: string }>({
				kind: "app.container",
				version: 1,
				scope: "conversation",
				history: "latest",
				fork: "current",
				initial: () => ({ image: "node:22" }),
			});
			const harness = await Harness.open(
				storage,
				{
					models,
					registry,
					env: async ({ conversationId, cwd, read }, context) => {
						const container = await read.snapshot(ContainerDoc, conversationId, context);
						return container !== undefined
							? containers.env(container.image, cwd ?? "/work", context)
							: localEnv(cwd ?? process.cwd());
					},
				},
				context,
			);
			return harness;
		},

		host: async () => {
			const registry = createRegistry();
			for (const extension of [
				CodingTools,
				Coding,
				ContextFiles,
				Skills,
				Permissions,
				Reviewer,
			]) {
				registry.install(extension);
			}
			const harness = await Harness.open(
				storage,
				{
					models,
					registry,
					settings: { extensions: [CodingTools, Coding, ContextFiles, Skills, Permissions] },
					env: ({ cwd }) => localEnv(cwd ?? process.cwd()),
				},
				context,
			);
			const root = await harness.root(context, { agent: { model: sonnet, cwd: process.cwd() } });

			await root.configure({ tools: { remove: [editTool] } }, context);
			await root.configure({ tools: { remove: [bashTool] } }, context);
			await root.configure({ tools: null }, context);

			registry.install(Timing);
			registry.install(Venv);
			const conversation = root;
			await conversation.configure({ extensions: { add: [Venv] } }, context);

			registry.install(PlanMode);
			await root.commit(async (tx) => {
				(await tx.doc(PlanModeDoc, root.id)).enabled = true;
			}, context);

			registry.install(Subagent);
			registry.install(Chat);
			registry.install(SkillsV2);
			registry.uninstall(Skills);
			return harness;
		},

		spawn: async (tx: Tx) => {
			const anchor = await tx.createTask(Anchor, null, {
				ownership: { kind: "conversation" },
				background: true,
			});
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, child.id, {
				extensions: { remove: [SubagentTools] },
				instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
			});
		},

		tableRules: async () => {
			await session.commit(async (tx) => {
				const conversation = await tx.conversation(conversationId);
				const live = await tx.doc(LiveDoc, conversationId);

				await tx.appendEntry(conversationId, message);
				delete live.generation;
				await tx.createTask(
					Follow,
					{},
					{ ownership: { kind: "conversation" }, conversationId },
				);
				void conversation;
			}, context);
		},

		revokedDraft: async () => {
			let escaped: Draft<LiveState> | undefined;
			await session.commit(async (tx) => {
				escaped = await tx.doc(LiveDoc, conversationId);
			}, context);
			escaped!.generation = undefined;
		},
	};
	return { sequences, Payment };
}

it("compiles the spec's usage examples", () => {
	expectTypeOf(examples).returns.toHaveProperty("sequences");
	expect(examples).toBeTypeOf("function");
});
