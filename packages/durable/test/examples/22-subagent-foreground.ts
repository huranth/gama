import type { Context } from "@huranth/chord";
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
	defineExtension,
	defineTool,
	type EntryId,
	type Extension,
	Harness,
	MemoryStorage,
	type ToolExecutionApi,
	watchEvents,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

async function answerText(
	api: ToolExecutionApi,
	answer: EntryId,
	callContext: Context,
): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), callContext);
	const message = entry?.model?.[0] as AssistantMessage;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
}

const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({
				task: Type.String({ description: "What the subagent should do" }),
			}),
			replay: "safe",
			execute: async (args, api, callContext) => {
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
				}, callContext);
				await api.details({ conversationId: child }, callContext);

				const handle = (await api.conversation(child, callContext))!;
				const request = {
					type: "input",
					content: task,
					requestId: `subagent:${api.taskId}`,
				} as const;
				const settled = await (await handle.submit(request, callContext)).wait(callContext);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`Subagent failed: ${settled.status}`);
				}
				const text = await answerText(api, settled.answer, callContext);
				return { content: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
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
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	const delegate = fauxToolCall(
		"subagent",
		{ task: "Name three prime numbers." },
		{ id: "call-1" },
	);
	faux.setResponses([
		fauxAssistantMessage([delegate], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("2, 3, and 5.")]),
		fauxAssistantMessage([fauxText("The subagent says: 2, 3, and 5.")]),
	] satisfies FauxResponseStep[]);
}
const registry = createRegistry();
registry.install(Subagent);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model } });

const print = (indent: string, event: AgentEvent): void => {
	if (event.type === "message_end" && event.entry.kind === "gama.assistant") {
		const message = event.entry.model?.[0] as AssistantMessage;
		const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
		if (text !== "") console.log(`${indent}assistant: ${text}`);
	} else if (event.type === "tool_execution_start") {
		console.log(`${indent}tool ${event.toolName}(${JSON.stringify(event.args)})`);
	}
};
const attached = new Set<ConversationId>();
const attach = async (id: ConversationId, indent: string): Promise<void> => {
	attached.add(id);
	const stream = await watchEvents(harness, id, context);
	stream.start(async (events) => {
		for (const event of events) {
			print(indent, event);
			if (event.type !== "tool_execution_update") continue;
			const child = (event.details as { conversationId?: ConversationId } | undefined)
				?.conversationId;
			if (child !== undefined && !attached.has(child)) await attach(child, `${indent}  `);
		}
	});
};
await attach(root.id, "");

const submission = await root.submit(
	{
		type: "input",
		content: "Use the subagent tool to find three prime numbers, then tell me what it said.",
	},
	context,
);
await submission.wait(context);
await harness.waitForIdle(context);
await new Promise((resolve) => setTimeout(resolve, 0));
await harness.close(context);
