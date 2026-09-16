import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createProvider, envApiKeyAuth, type Model } from "@huranth/gama-ai";
import { openAICompletionsApi } from "@huranth/gama-ai/compat";
import { createModels } from "@huranth/gama-ai/models";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	LiveDoc,
	MemoryStorage,
	section,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

if (process.env.OPENAI_API_KEY === undefined) {
	console.log("skipped: OPENAI_API_KEY is not set");
} else {
	const models = createModels();
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
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "concise",
			sections: [section("preamble", () => "You are a concise assistant.", { tag: false })],
		}),
	);
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	const root = await harness.root(context, {
		agent: { model: { provider: "openai", modelId: "gpt-6-sol" }, thinkingLevel: "high" },
	});
	const liveWatch = (await harness.watchDoc(LiveDoc, root.id, context))!;
	let printed = "";
	const printText = (text: string): void => {
		if (text.length <= printed.length || !text.startsWith(printed)) return;
		process.stdout.write(text.slice(printed.length));
		printed = text;
	};
	liveWatch.start(async (value) => {
		const block = value?.generation?.message?.content.find((content) => content.type === "text");
		if (block?.type === "text") printText(block.text);
	});
	harness.resume();
	process.stdout.write("answer: ");
	const poem = await root.submit({ type: "input", content: "Write a long poem" }, context);
	const settledPoem = await poem.wait(context);
	await liveWatch.stop();
	if (settledPoem.status === "done" && settledPoem.type === "input") {
		const entry = await root.commit(
			(tx) => tx.entry(AssistantEntry, settledPoem.answer),
			context,
		);
		const message = entry?.model?.[0];
		const block =
			message?.role === "assistant"
				? message.content.find((content) => content.type === "text")
				: undefined;
		if (block?.type === "text") printText(block.text);
		process.stdout.write("\n");
	} else {
		console.log("unanswered:", settledPoem.reason, settledPoem.detail);
	}
	await harness.close(context);
}
