import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { Type } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import {
	AgentDoc,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	type ToolRegistration,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

type AppTool = ToolRegistration & { readonly snippet?: string };

function exampleTool(name: string, description: string): AppTool {
	const tool = defineTool({
		name,
		description,
		parameters: Type.Object({ path: Type.String() }),
		execute: async (args) => ({ content: [{ type: "text", text: `${name} ${args.path}` }] }),
	});
	return { ...tool, snippet: `Use ${name} for files.` };
}

const read = exampleTool("read", "Read a file");
const write = exampleTool("write", "Write a file");
const grep = exampleTool("grep", "Search files");
const Files = defineExtension<AppTool>({ name: "files", tools: [read, write] });
const Search = defineExtension<AppTool>({ name: "search", tools: [grep] });
const Snippets = defineExtension<AppTool>({
	name: "snippets",
	sections: [
		section("tool_snippets", (input) => input.agent.tools.map((tool) => tool.snippet).join("\n")),
	],
});

const registry = createRegistry<AppTool>();
registry.install(Files);
registry.install(Search);
registry.install(Snippets);

let timeoutMs = 60_000;
const settings: HarnessSettings = {
	get stream() {
		return { timeoutMs };
	},
	retry: { maxRetries: 5 },
	toolExecution: "sequential",
};
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry, settings },
	context,
);
const root = await harness.root(context);

const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("default tools:", await tools());

await root.configure(
	{
		model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		thinkingLevel: "high",
		tools: [write, read],
	},
	context,
);
console.log("stored:", await harness.snapshot(AgentDoc, root.id, context));
const agent = await root.agent(context);
console.log("model:", agent.model, "thinking:", agent.thinkingLevel, "tools:", await tools());

await root.configure({ extensions: { remove: [Search] }, tools: null }, context);
console.log("without search:", await tools());

await root.configure({ extensions: [Files, Search] }, context);
registry.uninstall(Files);
console.log("files uninstalled:", await tools());
registry.install(Files);
console.log("files reinstalled:", await tools());

timeoutMs = 120_000;

await harness.close(context);
