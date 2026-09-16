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

const notesState = await session.documentState(Notes, chat.id, context);
if (notesState === undefined) throw new Error("notes are absent");
const stopNotes = notesState.subscribe((value, _deliveryContext, delivery) => {
	console.log("Chord notes:", delivery.kind, delivery.sequence, value);
});
await session.commit(async (tx) => {
	(await tx.doc(Notes, chat.id)).text = "published through Chord";
}, context);
stopNotes();
notesState.dispose();

await session.close(context);
