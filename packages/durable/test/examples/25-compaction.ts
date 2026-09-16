import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import type { AssistantMessage, Message, TranscriptContext } from "@huranth/gama-ai";
import { createModels } from "@huranth/gama-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@huranth/gama-ai/providers/faux";
import {
	CompactionEntry,
	type Conversation,
	createRegistry,
	Harness,
	LiveDoc,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

let overflowOnce = false;
let summaries = 0;
let hold: Promise<void> | undefined;
async function respond(transcript: TranscriptContext): Promise<AssistantMessage> {
	const first = transcript.messages[0];
	if (
		first?.role === "system" &&
		typeof first.content === "string" &&
		first.content.includes("summarization")
	) {
		summaries++;
		return fauxAssistantMessage(`## Goal\nPlan a week in Lisbon (summary #${summaries}).`);
	}
	if (overflowOnce) {
		overflowOnce = false;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" });
	}
	const held = hold;
	hold = undefined;
	await held;
	const question = transcript.messages.findLast((message) => message.role === "user");
	return fauxAssistantMessage(
		`A detailed answer to "${text(question)}": ${"details ".repeat(200)}`,
	);
}
const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: 3000, maxTokens: 1000 }] });
faux.setResponses(Array.from({ length: 100 }, () => respond));
const models = createModels();
models.setProvider(faux.provider);

let backgroundTokens = 800;
const settings = {
	get compaction() {
		return { reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens };
	},
};
const harness = await Harness.open(
	new MemoryStorage(),
	{ models, registry: createRegistry(), settings },
	context,
);
const root = await harness.root(context, {
	agent: { model: { provider: "faux", modelId: "tiny" } },
});

async function ask(question: string): Promise<void> {
	const submission = await root.submit({ type: "input", content: question }, context);
	const record = await submission.wait(context);
	const running = (await harness.snapshot(LiveDoc, root.id, context))?.compactions ?? [];
	for (const { taskId } of running) {
		await harness.waitForTask(taskId, context);
	}
	await show(
		root,
		`after "${question}" (${record.status === "done" ? "answered" : record.reason})`,
	);
}

for (const question of [
	"Where should we stay?",
	"What should we eat?",
	"Which day trips?",
	"Any museums?",
	"Nightlife?",
]) {
	await ask(question);
}

let finishAnswer!: () => void;
hold = new Promise((resolve) => {
	finishAnswer = resolve;
});
const busy = await root.submit({ type: "input", content: "How do we get around?" }, context);
const manual = await root.compact("Keep the hotel shortlist", context);
const { state } = await harness.waitForTask(manual, context);
const placement =
	state.outcome.status === "completed" ? state.outcome.result.submissionId : undefined;
const summary = (await harness.submission(placement!, context))!;
console.log("\nmanual compaction finished; its summary is", (await summary.status(context)).status);
finishAnswer();
await busy.wait(context);
console.log("after the answer, the summary is", (await summary.wait(context)).status);
await show(root, "after compact()");

backgroundTokens = 0;
await ask("What should we pack?");
overflowOnce = true;
await ask("Summarize the plan for my partner");

await harness.close(context);

async function show(conversation: Conversation, label: string): Promise<void> {
	const view = await conversation.context(context);
	const stored = (await conversation.entries({}, 1000, undefined, context)).items.length;
	console.log(`\n${label}: ${view.messages.length} messages in context, ${stored} entries stored`);
	const reason = CompactionEntry.is(view.head) ? view.head.data.reason : undefined;
	if (reason !== undefined) console.log(`  (${reason} compaction summary first)`);
	for (const message of view.messages) {
		const label = message.role === "system" ? "(system prompt)" : text(message).slice(0, 70);
		console.log(`  ${message.role.padEnd(9)} ${label}`);
	}
}

function text(message: Message | undefined): string {
	if (message === undefined || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	const block = message.content.find((content) => content.type === "text");
	return block?.type === "text" ? block.text.replaceAll("\n", " ") : "";
}
