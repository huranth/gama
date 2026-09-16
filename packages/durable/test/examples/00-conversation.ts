import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createSession, MemoryStorage } from "../../src/index.ts";

const session = createSession(new MemoryStorage());

const context = BACKGROUND_CONTEXT;

const standalone = await session.commit(
	(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
	context,
);
console.log("standalone conversation:", standalone);

await session.close(context);
