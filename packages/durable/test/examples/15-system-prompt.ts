import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@huranth/gama-ai/providers/faux";
import { NodeExecutionEnv } from "../../src/env/node.ts";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	SystemEntry,
	section,
	wrapSection,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage("Done."),
	fauxAssistantMessage("Done."),
	fauxAssistantMessage("Done."),
]);

const Coding = defineExtension({
	name: "coding",
	sections: [
		section("preamble", () => "You are a coding agent.", { tag: false }),
		section("cwd", (input) => input.env?.cwd),
	],
});
const AgentsMd = defineExtension({
	name: "agents-md",
	sections: [section("agents_md", () => "Run npm run check after changes.")],
});
const Terse = defineExtension({
	name: "terse",
	wraps: [
		wrapSection("preamble", (preamble) => ({
			...preamble,
			render: async (input, renderContext) =>
				`${await preamble.render(input, renderContext)} Be terse.`,
		})),
	],
});

const registry = createRegistry();
registry.install(Coding);
registry.install(AgentsMd);
registry.install(Terse);
const env = ({ cwd = "/" }: { readonly cwd?: string }) => new NodeExecutionEnv({ cwd });
const harness = await Harness.open(new MemoryStorage(), { models, registry, env }, context);
const model = { provider: "faux", modelId: "faux-1" };
const root = await harness.root(context, { agent: { model, cwd: "/repo" } });

const subagent = await harness.createConversation(
	{
		ownership: { kind: "ownerless" },
		agent: {
			model,
			cwd: "/repo",
			extensions: { remove: [AgentsMd] },
			instructions: "Only read; never edit files.",
		},
	},
	context,
);

async function systemEntries(conversation: Conversation) {
	const page = await conversation.entries({}, 20, undefined, context);
	return [...page.items]
		.reverse()
		.flatMap((entry) => (SystemEntry.is(entry) ? (entry.model ?? []) : []));
}

await (await root.submit({ type: "input", content: "Fix the build." }, context)).wait(context);
await (await subagent.submit({ type: "input", content: "Read the logs." }, context)).wait(context);
console.log("root system prompt:", await systemEntries(root));
console.log("subagent system prompt:", await systemEntries(subagent));

await root.configure({ cwd: "/repo/packages" }, context);
await (await root.submit({ type: "input", content: "Now the package." }, context)).wait(context);
console.log("root system entries after cwd change:", await systemEntries(root));

await harness.close(context);
