import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import type { ToolResultMessage } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@huranth/gama-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	section,
	ToolResultEntry,
} from "../../src/index.ts";
import { CodingTools } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const workspace = await mkdtemp(join(tmpdir(), "gama-durable-agent-"));
await mkdir(join(workspace, "app"));

const Coding = defineExtension({
	name: "coding",
	sections: [
		section("preamble", () => "You are a coding agent. Use the tools to inspect the project.", {
			tag: false,
		}),
		section("cwd", (input) => input.env?.cwd),
	],
});
const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);

const userSettings = { parallelTools: true, maxRetries: 3 };
const settings: HarnessSettings = {
	get toolExecution() {
		return userSettings.parallelTools ? "parallel" : "sequential";
	},
	get retry() {
		return { maxRetries: userSettings.maxRetries };
	},
};

const env = ({ cwd = workspace }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const pwd = () =>
	fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
faux.setResponses([pwd(), fauxAssistantMessage("Done."), pwd(), fauxAssistantMessage("Done.")]);

const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry, settings, env },
	context,
);
const root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace },
});

const lastBashOutput = async () => {
	const page = await root.entries({}, 10, undefined, context);
	const result = page.items.find((entry) => ToolResultEntry.is(entry))
		?.model?.[0] as ToolResultMessage;
	return result.content.map((part) => (part.type === "text" ? part.text.trim() : "")).join("");
};

await (await root.submit({ type: "input", content: "Where are we?" }, context)).wait(context);
console.log("bash ran in:", await lastBashOutput());

await root.configure({ cwd: join(workspace, "app") }, context);
userSettings.parallelTools = false;
await (await root.submit({ type: "input", content: "And now?" }, context)).wait(context);
console.log("bash ran in:", await lastBashOutput());

await harness.close(context);
await rm(workspace, { recursive: true, force: true });
