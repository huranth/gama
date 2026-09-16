import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@huranth/gama-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;

const Sandbox = defineDoc<{ path?: string }>({
	kind: "app.sandbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const note = (text: string) =>
	fauxAssistantMessage(fauxToolCall("write", { path: "note.txt", content: text }), {
		stopReason: "toolUse",
	});
faux.setResponses([
	note("from alice"),
	fauxAssistantMessage("Saved."),
	note("from bob"),
	fauxAssistantMessage("Saved."),
]);

const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(
	new MemoryStorage(),
	{
		models,
		registry,
		env: async ({ conversationId, read }, envContext) => {
			const sandbox = await read.snapshot(Sandbox, conversationId, envContext);
			return sandbox?.path === undefined
				? undefined
				: new NodeExecutionEnv({ cwd: sandbox.path });
		},
	},
	context,
);

const model = { provider: "faux", modelId: "faux-1" };
async function conversationFor(user: string) {
	const path = await mkdtemp(join(tmpdir(), `gama-durable-sandbox-${user}-`));
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model },
			init: async (tx, id) => {
				(await tx.doc(Sandbox, id)).path = path;
			},
		},
		context,
	);
	return { conversation, path };
}

const alice = await conversationFor("alice");
const bob = await conversationFor("bob");
await (await alice.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(
	context,
);
await (await bob.conversation.submit({ type: "input", content: "Leave a note." }, context)).wait(
	context,
);
console.log("alice's sandbox:", await readFile(join(alice.path, "note.txt"), "utf8"));
console.log("bob's sandbox:", await readFile(join(bob.path, "note.txt"), "utf8"));

await harness.close(context);
await rm(alice.path, { recursive: true, force: true });
await rm(bob.path, { recursive: true, force: true });
