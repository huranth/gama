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
await session.commit(async (tx) => {
	await tx.appendEntry(chat.id, { kind: "note", data: "goodbye" });
	(await tx.doc(Notes, chat.id)).text = "after goodbye";
}, context);

const branch = await session.commit(
	(tx) => tx.forkConversation(chat.id, firstEntry.id, { ownership: { kind: "ownerless" } }),
	context,
);

const branchEntries = await session.commit(
	(tx) => tx.scanEntries({ conversationId: branch.id }, 10),
	context,
);
console.log(
	"fork transcript:",
	branchEntries.items.map((entry) => entry.data),
);
console.log("fork notes:", await session.snapshot(Notes, branch.id, context));

await session.commit(async (tx) => {
	(await tx.doc(Notes, branch.id)).text = "changed only in the fork";
}, context);
console.log("fork notes after edit:", await session.snapshot(Notes, branch.id, context));
console.log("parent notes after edit:", await session.snapshot(Notes, chat.id, context));

await session.close(context);
