import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { Type } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@huranth/gama-ai/providers/faux";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

const Todos = defineDoc<{ items: string[] }>({
	kind: "example.todos",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ items: [] }),
});

const Todo = defineExtension({
	name: "todo",
	tools: [
		defineTool({
			name: "todo",
			description: "Add an item to your todo list",
			parameters: Type.Object({ item: Type.String() }),
			execute: async (args, api, callContext) => {
				await api.commit(async (tx) => {
					(await tx.doc(Todos, api.conversationId)).items.push(args.item);
				}, callContext);
				return { content: [{ type: "text", text: `added ${args.item}` }] };
			},
		}),
	],
	sections: [
		section("todos", async (input, renderContext) => {
			const todos = await input.read.snapshot(Todos, input.conversationId, renderContext);
			return todos === undefined || todos.items.length === 0
				? undefined
				: todos.items.join("\n");
		}),
	],
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(Todo);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "faux-1" } },
});

faux.setResponses([
	fauxAssistantMessage(fauxToolCall("todo", { item: "fix the build" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("Noted."),
	fauxAssistantMessage("Working on it."),
]);
await (await root.submit({ type: "input", content: "Remember to fix the build." }, context)).wait(
	context,
);
console.log("todos:", await harness.snapshot(Todos, root.id, context));

await (await root.submit({ type: "input", content: "What is next?" }, context)).wait(context);
const { messages } = await root.context(context);
console.log(
	"system messages:",
	messages.flatMap((message) =>
		message.role === "system"
			? [
					{
						sections: message.sections,
						toolsAdded: message.toolsAdded?.map((tool) => tool.name),
					},
				]
			: [],
	),
);

await harness.close(context);
