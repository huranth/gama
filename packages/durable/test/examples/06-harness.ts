import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { Type } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import {
	AgentDoc,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

const read = defineTool({
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
	execute: async (args) => ({ content: [{ type: "text", text: `contents of ${args.path}` }] }),
});
const Files = defineExtension({ name: "files", tools: [read] });
const registry = createRegistry();
registry.install(Files);

const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry },
	context,
);

const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});

const root = await harness.root(context, {
	agent: { thinkingLevel: "low" },
	init: async (tx, rootId) => {
		(await tx.doc(Notes, rootId)).text = "root notes";
	},
});
console.log("root:", root.id, await harness.snapshot(Notes, root.id, context));
console.log("stored agent:", await harness.snapshot(AgentDoc, root.id, context));
const agent = await root.agent(context);
console.log(
	"resolved:",
	agent.thinkingLevel,
	agent.extensions.map((extension) => extension.name),
	agent.tools.map((tool) => tool.name),
);

await harness.close(context);
