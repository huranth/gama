import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { type ToolResultMessage, Type } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@huranth/gama-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	ToolResultEntry,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

let started = (): void => {};
let gate = Promise.resolve();
function loadVersioned(version: string) {
	return defineExtension({
		name: "versioned",
		tools: [
			defineTool({
				name: "version",
				description: "Report the tool's code version",
				parameters: Type.Object({}),
				execute: async () => {
					started();
					await gate;
					return { content: [{ type: "text", text: version }] };
				},
			}),
		],
	});
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const callVersion = () =>
	fauxAssistantMessage(fauxToolCall("version", {}), { stopReason: "toolUse" });
faux.setResponses([
	callVersion(),
	fauxAssistantMessage("Done."),
	callVersion(),
	fauxAssistantMessage("Done."),
]);

const directory = await mkdtemp(join(tmpdir(), "gama-durable-reload-"));
const open = async (registry: ReturnType<typeof createRegistry>) =>
	Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry },
		context,
	);

let registry = createRegistry();
registry.install(loadVersioned("v1"));
let harness = await open(registry);
let root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [loadVersioned("v1")] },
});
const lastResult = async () => {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))
		?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

let release = (): void => {};
gate = new Promise((resolve) => {
	release = resolve;
});
const running = new Promise<void>((resolve) => {
	started = resolve;
});
const submission = await root.submit({ type: "input", content: "Which version?" }, context);
await running;
registry.install(loadVersioned("v2"));
release();
await submission.wait(context);
console.log("call running during the reload:", await lastResult());
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("next call:", await lastResult());
await harness.close(context);

registry = createRegistry();
harness = await open(registry);
root = await harness.root(context);
const tools = async () => (await root.agent(context)).tools.map((tool) => tool.name);
console.log("after restart, before install:", await tools());
registry.install(loadVersioned("v3"));
console.log("after install:", await tools());

await harness.close(context);
await rm(directory, { recursive: true, force: true });
