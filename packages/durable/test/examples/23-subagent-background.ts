import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import {
	type AssistantMessage,
	createProvider,
	envApiKeyAuth,
	type FauxResponseStep,
	type Model,
	Type,
} from "@huranth/gama-ai";
import { openAICompletionsApi } from "@huranth/gama-ai/compat";
import { createModels } from "@huranth/gama-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@huranth/gama-ai/providers/faux";
import {
	type AgentEvent,
	AssistantEntry,
	type ConversationId,
	configure,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	Harness,
	LiveDoc,
	type TaskId,
	watchEvents,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

type Subagent = {
	conversationId: ConversationId;
	reported: EntryId[];
};
const Subagents = defineDoc<{
	agents: Record<string, Subagent>;
	reporters: Record<string, TaskId>;
}>({
	kind: "app.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {}, reporters: {} }),
});

const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "app.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				taskContext,
			),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

type ReporterInput = {
	name: string;
	conversationId: ConversationId;
	message: string;
	followUp: boolean;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "app.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, taskContext) => {
			const { name, conversationId, message, followUp } = reporter.input;
			const subagent = (await runtime.conversation(conversationId, taskContext))!;
			const request = {
				type: "input",
				content: message,
				whenBusy: followUp ? "followUp" : "steer",
			} as const;
			const submission = await subagent.submit(
				{ ...request, requestId: `subagent:${reporter.id}` },
				taskContext,
			);
			const settled = await submission.wait(taskContext);
			await runtime.commit(async (tx) => {
				const next = (report?: string) =>
					({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled.status === "unanswered") {
					return next(
						settled.reason === "aborted"
							? undefined
							: `[subagent ${name} failed: ${settled.reason}]`,
					);
				}
				if (settled.type !== "input") return next();
				const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name]!;
				if (agent.reported.includes(settled.answer)) return next();
				agent.reported.push(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))
					?.model?.[0] as AssistantMessage;
				return next(`[subagent ${name} answered, no reply needed] ${textOf(answer)}`);
			}, taskContext);
		},
		report: async (reporter, runtime, taskContext) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const main = (await runtime.conversation(runtime.conversationId, taskContext))!;
				const input = { type: "input", content: report, whenBusy: "followUp" } as const;
				await main.submit(
					{ ...input, requestId: `subagent-report:${reporter.id}` },
					taskContext,
				);
			}
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				taskContext,
			);
		},
	},
	abort: (_reporter, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const subagentTool = defineTool({
	name: "subagent",
	description:
		"Manage persistent subagents that work in the background. " +
		"Actions: spawn (name, message), send (name, message; followUp: true queues " +
		"it after the current answer instead of steering), stop (name: aborts its " +
		"current work), " +
		"status (name, or all subagents without one). Answers are reported back to you when they arrive.",
	parameters: Type.Object({
		action: Type.Union([
			Type.Literal("spawn"),
			Type.Literal("send"),
			Type.Literal("stop"),
			Type.Literal("status"),
		]),
		name: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		followUp: Type.Optional(Type.Boolean()),
	}),
	replay: "unsafe",
	execute: async (args, api, callContext) => {
		const { action, name, message, followUp } = args;
		const reply = (text: string, conversationId?: ConversationId) => ({
			content: [{ type: "text" as const, text }],
			...(conversationId === undefined || name === undefined
				? {}
				: { details: { name, conversationId } }),
		});
		const registry = (await api.snapshot(Subagents, api.conversationId, callContext)) ?? {
			agents: {},
			reporters: {},
		};

		if (action === "status") {
			const names = name === undefined ? Object.keys(registry.agents) : [name];
			const lines: string[] = [];
			for (const each of names) {
				const found = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
				if (found === undefined) continue;
				const busy =
					(await api.snapshot(LiveDoc, found.conversationId, callContext))?.run !== undefined;
				lines.push(`${each}: ${busy ? "working" : "idle"}`);
			}
			return reply(lines.length === 0 ? "No subagents." : lines.join("\n"));
		}
		if (name === undefined) return reply(`${action} needs a name.`);
		const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
		if (action !== "spawn" && agent === undefined) return reply(`No subagent named ${name}.`);

		if (action === "stop") {
			await (await api.conversation(agent!.conversationId, callContext))!.abort(callContext);
			return reply(`Stopped ${name}.`, agent!.conversationId);
		}
		if (message === undefined) return reply(`${action} needs a message.`);

		const result = await api.commit(async (tx) => {
			const state = await tx.doc(Subagents, api.conversationId);
			const background = { ownership: { kind: "conversation" }, background: true } as const;
			if (action === "spawn") {
				if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
				const anchor = await tx.createTask(Anchor, null, background);
				const child = await tx.createConversation({
					ownership: { kind: "task", taskId: anchor },
				});
				await configure(tx, child.id, {
					extensions: { remove: [SubagentTools] },
					instructions: `You are the subagent "${name}". Answer the main agent's requests.`,
				});
				state.agents[name] = { conversationId: child.id, reported: [] };
			}
			const conversationId = state.agents[name]!.conversationId;
			const input = {
				name,
				conversationId,
				message,
				followUp: action === "send" && followUp === true,
			};
			state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
			return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
		}, callContext);
		const current = (await api.snapshot(Subagents, api.conversationId, callContext))?.agents[
			name
		];
		return reply(result, current?.conversationId);
	},
});

const SubagentTools = defineExtension({
	name: "subagent-tools",
	tasks: [Anchor, Reporter],
	tools: [subagentTool],
});

const models = createModels();
let model = { provider: "openai", modelId: "gpt-6-sol" };
if (process.env.OPENAI_API_KEY !== undefined) {
	const baseUrl = "https://api.openai.com/v1";
	const openaiModel: Model<"openai-completions"> = {
		id: "gpt-6-sol",
		name: "gpt-6-sol",
		api: "openai-completions",
		provider: "openai",
		baseUrl,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
	models.setProvider(
		createProvider({
			id: "openai",
			name: "OpenAI",
			baseUrl,
			auth: { apiKey: envApiKeyAuth("OPENAI_API_KEY", ["OPENAI_API_KEY"]) },
			api: openAICompletionsApi(),
			models: [openaiModel],
		}),
	);
} else {
	const faux = fauxProvider({ tokensPerSecond: 50 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const call = (input: Record<string, string>) =>
		fauxAssistantMessage([fauxToolCall("subagent", input)], { stopReason: "toolUse" });
	const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
	const route: FauxResponseStep = (request) => {
		const last = request.messages.findLast((message) => message.role !== "system")!;
		const content =
			typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
		const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
		if (last.role === "toolResult") return answer(`OK. ${text}`);
		if (text.includes("Start a subagent")) {
			return call({
				action: "spawn",
				name: "reader",
				message: "Summarize the plot of Moby Dick.",
			});
		}
		if (text.includes("whale's name"))
			return call({ action: "send", name: "reader", message: "What is the whale called?" });
		if (text.includes("every chapter")) {
			return call({
				action: "send",
				name: "reader",
				message: "Now go through all chapters in detail.",
			});
		}
		if (text.includes("Stop reader")) return call({ action: "stop", name: "reader" });
		if (text.includes("my subagents")) return call({ action: "status" });
		if (text.includes("[subagent")) return answer("Noted.");
		if (text.includes("Summarize the plot")) return answer("A whale, a captain, an obsession.");
		if (text.includes("whale called")) return answer("Moby Dick.");
		const chapters = Array.from(
			{ length: 135 },
			(_, index) => `Chapter ${index + 1}: more whaling.`,
		);
		return answer(chapters.join("\n"));
	};
	faux.setResponses(Array.from({ length: 40 }, () => route));
}
const registry = createRegistry();
registry.install(SubagentTools);
const directory = await mkdtemp(join(tmpdir(), "gama-durable-subagents-"));
const open = async () => {
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry },
		context,
	);
	const root = await harness.root(context, { agent: { model } });
	return { harness, root };
};

const color = (code: number) => (text: string) =>
	process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = color(1);
const dim = color(2);
const cyan = color(36);
const yellow = color(33);
const magenta = color(35);

function contentText(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("");
}

async function follow(harness: Harness, id: ConversationId): Promise<void> {
	const stream = await watchEvents(harness, id, context);
	stream.start(async (events: readonly AgentEvent[]) => {
		for (const event of events) {
			if (event.type !== "message_end") continue;
			const message = event.entry.model?.[0];
			if (message?.role === "user") {
				const text = contentText(message.content);
				const report = /^\[subagent (\S+) ([^\]]*)\] ?(.*)$/s.exec(text);
				if (report === null) console.log(`\n${cyan(bold(">"))} ${bold(text)}`);
				else console.log(`\n${magenta(bold(`> ${report[1]}:`))} ${report[3] || report[2]}`);
			} else if (message?.role === "assistant") {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					const {
						action,
						name,
						message: sent,
					} = part.arguments as Record<string, string | undefined>;
					const quoted = sent === undefined ? "" : ` ${JSON.stringify(sent)}`;
					console.log(
						yellow(
							`  ${part.name} ${action}${name === undefined ? "" : ` ${name}`}${quoted}`,
						),
					);
				}
				if (textOf(message) !== "") console.log(textOf(message));
			} else if (message?.role === "toolResult") {
				console.log(dim(`  → ${contentText(message.content)}`));
			}
		}
	});
}

let { harness, root } = await open();
await follow(harness, root.id);

const say = async (text: string): Promise<void> => {
	await (await root.submit({ type: "input", content: text }, context)).wait(context);
};
const settle = async (): Promise<void> => {
	const reporters = (await harness.snapshot(Subagents, root.id, context))?.reporters ?? {};
	for (const id of Object.values(reporters)) {
		await harness.waitForTask(id, context);
	}
	await root.waitForIdle(context);
	await new Promise((resolve) => setTimeout(resolve, 50));
};
const until = async (check: () => Promise<boolean>): Promise<void> => {
	for (let tries = 0; tries < 1000 && !(await check()); tries++)
		await new Promise((resolve) => setTimeout(resolve, 10));
};
const working = async (name: string): Promise<boolean> => {
	const agent = (await harness.snapshot(Subagents, root.id, context))?.agents[name];
	return (
		agent !== undefined &&
		(await harness.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined
	);
};

await say("Start a subagent named reader that summarizes Moby Dick.");
await settle();

await say("Ask reader to summarize every chapter.");
await until(() => working("reader"));
await say("Stop reader.");
await settle();

await say("What are my subagents doing?");
await settle();

const reporters = async () =>
	Object.keys((await harness.snapshot(Subagents, root.id, context))?.reporters ?? {}).length;
const before = await reporters();
await root.submit({ type: "input", content: "Ask reader for the whale's name." }, context);
await until(async () => (await reporters()) > before);
await harness.close(context);
console.log(dim("\n  (process restarts)"));
({ harness, root } = await open());
await follow(harness, root.id);
await settle();

await harness.close(context);
await rm(directory, { recursive: true, force: true });
