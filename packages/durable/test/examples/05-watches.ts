import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createSession, defineDoc, MemoryStorage } from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

const Notes = defineDoc<{ text: string }>({
	kind: "example.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});
const chat = await session.commit(async (tx) => {
	const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
	(await tx.doc(Notes, conversation.id)).text = "first";
	return conversation;
}, context);

const notesWatch = await session.watchDoc(Notes, chat.id, context);
if (notesWatch === undefined) throw new Error("notes are absent");
console.log("watch baseline:", notesWatch.value);
const delivered = new Promise<void>((resolve) => {
	notesWatch.start(async (value, _ops, _deliveryContext) => {
		console.log("watch update:", value);
		resolve();
	});
});
await session.commit(async (tx) => {
	(await tx.doc(Notes, chat.id)).text = "observed asynchronously";
}, context);
await delivered;
await notesWatch.stop();

await session.close(context);
