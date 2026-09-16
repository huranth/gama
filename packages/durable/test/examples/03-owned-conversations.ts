import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import {
	type ConversationId,
	createSession,
	defineDoc,
	defineTask,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;
const session = createSession(new MemoryStorage());

const Supervisor = defineTask<null, { phase: "ready" }, null>({
	name: "example.supervisor",
	version: 1,
	initial: () => ({ phase: "ready" }),
	phases: { ready: async () => {} },
	abort: async () => {},
});

const AgentRegistry = defineDoc<{
	agents: Record<string, { conversationId: ConversationId; requestId: string }>;
}>({
	kind: "example.agent-registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

const main = await session.commit(
	(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
	context,
);

const setup = await session.commit(async (tx) => {
	const supervisorId = await tx.createTask(Supervisor, null, {
		ownership: { kind: "conversation" },
		conversationId: main.id,
		background: true,
	});

	const child = await tx.createConversation({ ownership: { kind: "task", taskId: supervisorId } });

	(await tx.doc(AgentRegistry, main.id)).agents.researcher = {
		conversationId: child.id,
		requestId: `researcher:first-message:${supervisorId}`,
	};
	return { supervisorId, child };
}, context);

console.log("supervisor task:", setup.supervisorId);
console.log("child conversation:", setup.child);
console.log("registry:", await session.snapshot(AgentRegistry, main.id, context));

await session.close(context);
