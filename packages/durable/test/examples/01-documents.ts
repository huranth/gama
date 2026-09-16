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

const chat = await session.commit(
	(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
	context,
);

const firstEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "hello" });
	(await tx.doc(Notes, chat.id)).text = "after hello";
	return entry;
}, context);

const secondEntry = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
	return entry;
}, context);

console.log("latest notes:", await session.snapshot(Notes, chat.id, context));
console.log(
	"notes at first entry:",
	await session.snapshotAsOf(Notes, chat.id, firstEntry.id, context),
);
console.log(
	"notes at second entry:",
	await session.snapshotAsOf(Notes, chat.id, secondEntry.id, context),
);

await session.close(context);
