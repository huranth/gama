import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createProvider, envApiKeyAuth, type Model } from "@huranth/gama-ai";
import { openAICompletionsApi } from "@huranth/gama-ai/compat";
import { createModels } from "@huranth/gama-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@huranth/gama-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	type Storage,
	section,
	watchEvents,
} from "../../src/index.ts";
import { openNodeJsonlStorage } from "../../src/storage/jsonl/node.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const args = process.argv.slice(2);
const mode = args.includes("--ops") ? "ops" : "events";
const storageIndex = args.indexOf("--storage");
const storageKind = storageIndex < 0 ? "sqlite" : args[storageIndex + 1];
const prompt =
	args.find(
		(arg, index) => !arg.startsWith("--") && (storageIndex < 0 || index !== storageIndex + 1),
	) ?? "What is in this directory?";

let storage: Storage;
let location: string | undefined;
if (storageKind === "sqlite") {
	location = join(tmpdir(), `gama-durable-json-${Date.now()}.sqlite`);
	storage = await openNodeSqliteStorage(location);
} else if (storageKind === "jsonl") {
	location = await mkdtemp(join(tmpdir(), "gama-durable-json-"));
	storage = await openNodeJsonlStorage(location, context);
} else if (storageKind === "memory") {
	storage = new MemoryStorage();
} else {
	throw new Error(`Unknown --storage ${storageKind}; use sqlite, jsonl, or memory`);
}
const print = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);

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
	const faux = fauxProvider({ tokensPerSecond: 200 });
	models.setProvider(faux.provider);
	model = { provider: "faux", modelId: "faux-1" };
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "ls" }, { id: "call-1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([
			fauxText("This directory holds the durable package sources, tests, and docs."),
		]),
	]);
}

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "coding",
		tools: [createReadTool(), createBashTool()],
		sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
	}),
);
const env = new NodeExecutionEnv({ cwd: process.cwd() });
const harness = await Harness.open(storage, { models, registry, env: () => env }, context);
const root = await harness.root(context, { agent: { model } });

let stop: () => Promise<unknown>;
if (mode === "events") {
	const stream = await watchEvents(harness, root.id, context);
	print(stream.snapshot);
	stream.start(async (events) => {
		for (const event of events) {
			print(event);
		}
	});
	stop = () => stream.stop();
} else {
	const watch = await root.watch(context);
	print({ view: watch.value });
	watch.start(async (_value, ops) => print({ ops }));
	stop = () => watch.stop();
}

const submission = await root.submit({ type: "input", content: prompt }, context);
await submission.wait(context);
await harness.waitForIdle(context);
await new Promise((resolve) => setTimeout(resolve, 0));
await stop();
await harness.close(context);
if (location !== undefined) console.error(`${storageKind} storage: ${location}`);
