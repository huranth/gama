import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import type { AssistantMessage } from "@huranth/gama-ai";
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
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";
import { createBashTool, createReadTool } from "../../src/tools/index.ts";

const context = BACKGROUND_CONTEXT;
const prompt = process.argv[2] ?? "What is in this directory?";

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
	const faux = fauxProvider();
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
const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry, env: () => env },
	context,
);
const root = await harness.root(context, { agent: { model } });

const submission = await root.submit({ type: "input", content: prompt }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const answer = entry?.model?.[0] as AssistantMessage;
	console.log(
		answer.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join(""),
	);
} else {
	console.error(
		`unanswered: ${settled.status === "unanswered" ? settled.reason : settled.status}`,
	);
	process.exitCode = 1;
}
await harness.close(context);
