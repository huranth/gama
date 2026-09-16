import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import type { ToolResultMessage } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@huranth/gama-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	ToolResultEntry,
	wrapTool,
} from "../../src/index.ts";
import { CodingTools, createBashTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

const Venv = defineExtension({
	name: "venv",
	tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })],
});

const timings: number[] = [];
const Timing = defineExtension({
	name: "timing",
	wraps: [
		wrapTool(createBashTool(), (bash) => ({
			...bash,
			execute: async (args, api, callContext) => {
				const start = Date.now();
				try {
					return await bash.execute(args, api, callContext);
				} finally {
					timings.push(Date.now() - start);
				}
			},
		})),
	],
});

const project = await mkdtemp(join(tmpdir(), "gama-durable-venv-"));
await mkdir(join(project, ".venv/bin"), { recursive: true });
await writeFile(join(project, ".venv/bin/activate"), `export VIRTUAL_ENV="${project}/.venv"\n`);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const probe = () =>
	fauxAssistantMessage(fauxToolCall("bash", { command: "echo venv: $VIRTUAL_ENV" }), {
		stopReason: "toolUse",
	});
faux.setResponses([probe(), fauxAssistantMessage("Done."), probe(), fauxAssistantMessage("Done.")]);

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Timing);
registry.install(Venv);
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		settings: { extensions: [CodingTools, Timing] },
		env: () => new NodeExecutionEnv({ cwd: project }),
	},
	context,
);
const model = { provider: "faux", modelId: "faux-1" };
const plain = await harness.root(context, { agent: { model } });
const python = await harness.createConversation(
	{ ownership: { kind: "ownerless" }, agent: { model, extensions: { add: [Venv] } } },
	context,
);

async function probeBash(conversation: Conversation): Promise<string> {
	await (await conversation.submit({ type: "input", content: "Which venv?" }, context)).wait(
		context,
	);
	const page = await conversation.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))
		?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
}

console.log("plain conversation:", await probeBash(plain));
console.log("python conversation:", (await probeBash(python)).replace(project, "<project>"));
console.log("timed bash calls:", timings.length);

await harness.close(context);
await rm(project, { recursive: true, force: true });
