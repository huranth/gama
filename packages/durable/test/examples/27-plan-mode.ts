import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { Type } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@huranth/gama-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";
import { CodingTools, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

const PlanDoc = defineDoc<{ steps: string[] }>({
	kind: "app.plan",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ steps: [] }),
});

const submitPlan = defineTool({
	name: "submit_plan",
	description: "Submit the plan as a list of steps.",
	parameters: Type.Object({ steps: Type.Array(Type.String()) }),
	execute: async (args, api, callContext) => {
		await api.commit(async (tx) => {
			(await tx.doc(PlanDoc, api.conversationId)).steps = args.steps;
		}, callContext);
		return { content: [{ type: "text", text: "Plan submitted." }], control: { terminate: true } };
	},
});

const Plan = defineExtension({
	name: "plan",
	tools: [submitPlan],
	sections: [
		section(
			"plan_mode",
			() => "You are in plan mode. Read the code, then call submit_plan. Change nothing.",
		),
	],
});

const read = createReadTool();
const enterPlanMode = { extensions: { add: [Plan] }, tools: [read, submitPlan] };
const leavePlanMode = { extensions: null, tools: null };

const directory = await mkdtemp(join(tmpdir(), "gama-durable-plan-"));
await writeFile(join(directory, "server.ts"), "app.listen(3000);\n");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("read", { path: "server.ts" }), { stopReason: "toolUse" }),
	fauxAssistantMessage(
		fauxToolCall("submit_plan", { steps: ["Read PORT from the environment", "Default to 3000"] }),
		{
			stopReason: "toolUse",
		},
	),
	fauxAssistantMessage("Implementing step 1."),
]);

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Plan);
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		settings: { extensions: [CodingTools] },
		env: () => new NodeExecutionEnv({ cwd: directory }),
	},
	context,
);
const root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "faux-1" } },
});
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("tools:", await tools());

await root.configure(enterPlanMode, context);
console.log("plan mode tools:", await tools());
await (await root.submit({ type: "input", content: "Make the port configurable." }, context)).wait(
	context,
);
console.log("plan:", (await harness.snapshot(PlanDoc, root.id, context))?.steps);

await root.configure(leavePlanMode, context);
console.log("tools again:", await tools());
await (await root.submit({ type: "input", content: "Go ahead." }, context)).wait(context);

const { messages } = await root.context(context);
for (const message of messages) {
	if (message.role !== "system") continue;
	console.log("system:", {
		sections: message.sections,
		added: message.toolsAdded?.map((tool) => tool.name),
		removed: message.toolsRemoved?.map((tool) => tool.name),
	});
}

await harness.close(context);
await rm(directory, { recursive: true, force: true });
