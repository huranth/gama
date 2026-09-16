import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import type { FauxResponseStep } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@huranth/gama-ai/providers/faux";
import {
	createRegistry,
	Harness,
	InboxDoc,
	MemoryStorage,
	type Submission,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

let release!: () => void;
const held = new Promise<void>((resolve) => {
	release = resolve;
});
const slow: FauxResponseStep = async () => {
	await held;
	return fauxAssistantMessage("Answer to the first question.");
};
const faux = fauxProvider();
faux.setResponses([slow, fauxAssistantMessage("Answer to the follow-up and the steer.")]);
const models = createModels();
models.setProvider(faux.provider);

const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry: createRegistry(), settings: { followUpMode: "all" } },
	context,
);
const root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const first = await root.submit({ type: "input", content: "First question" }, context);

const followUp = await root.submit({ type: "input", content: "A follow-up" }, context);
const steer = await root.submit({ type: "input", content: "A steer", whenBusy: "steer" }, context);
const note = await root.submit(
	{ type: "write", entry: { kind: "app.note", data: "noted while busy" } },
	context,
);
const withdrawn = await root.submit({ type: "input", content: "Never mind" }, context);
await root
	.submit({ type: "input", content: "Now or never", whenBusy: "reject" }, context)
	.catch((error: Error) => {
		console.log("rejected:", error.message);
	});
console.log("withdraw:", await withdrawn.abort(context));

const inbox = await harness.snapshot(InboxDoc, root.id, context);
console.log(
	"inbox:",
	inbox?.items.map((item) => `${item.id} ${item.mode}`),
);

release();
const status = async (name: string, submission: Submission) => {
	const record = await submission.wait(context);
	console.log(`${name}:`, record.status, record.status === "unanswered" ? record.reason : "");
};
await status("first", first);
await status("follow-up", followUp);
await status("steer", steer);
await status("note", note);
await status("withdrawn", withdrawn);

const page = await root.entries({}, 20, undefined, context);
console.log(
	"transcript:",
	[...page.items].reverse().map((entry) => entry.kind),
);
await harness.close(context);
