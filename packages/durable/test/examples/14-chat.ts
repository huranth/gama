import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@huranth/gama-ai/providers/faux";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	section,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Paris.")]);

const registry = createRegistry();
registry.install(
	defineExtension({
		name: "terse",
		sections: [section("preamble", () => "You answer in one word.", { tag: false })],
	}),
);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const capital = await root.submit({ type: "input", content: "Capital of France?" }, context);
const answered = await capital.wait(context);
if (answered.status === "done" && answered.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, answered.answer), context);
	const reply = entry?.model?.[0];
	console.log("answer:", reply?.role === "assistant" ? reply.content : reply);
}

const transcript = await root.entries({}, 10, undefined, context);
console.log(
	"transcript:",
	[...transcript.items].reverse().map((entry) => entry.kind),
);
await harness.close(context);
