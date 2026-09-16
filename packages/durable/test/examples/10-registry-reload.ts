import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { Type } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	wrapTool,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

function exampleTool(name: string, description: string) {
	return defineTool({
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args) => ({ content: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
}

const read = exampleTool("read", "Read a file");
const registry = createRegistry();
registry.install(
	defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files")] }),
);
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry },
	context,
);
const root = await harness.root(context);
const tools = async () =>
	(await root.agent(context)).tools.map((tool) => `${tool.name}: ${tool.description}`);

registry.install(
	defineExtension({ name: "files", tools: [read, exampleTool("grep", "Search files, faster")] }),
);
console.log("after reload:", await tools());

const Audit = defineExtension({
	name: "audit",
	wraps: [wrapTool(read, (tool) => ({ ...tool, description: `${tool.description} (audited)` }))],
});
registry.install(Audit);
console.log("with audit:", await tools());

registry.uninstall(Audit);
console.log("after uninstall:", await tools());

await harness.close(context);
