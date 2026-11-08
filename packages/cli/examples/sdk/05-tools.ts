import { createAgentSession, SessionStore } from "@huranth/gama-harness";

const { session: readOnlySession } = await createAgentSession({
	tools: ["read", "grep", "find", "ls"],
	sessionManager: SessionStore.inMemory(),
});
console.log("Read-only session created");
readOnlySession.dispose();

const { session: customToolsSession } = await createAgentSession({
	tools: ["read", "bash", "grep"],
	sessionManager: SessionStore.inMemory(),
});
console.log("Custom tools session created");
customToolsSession.dispose();

const customCwd = "/path/to/project";
const { session: customCwdSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "edit", "write"],
	sessionManager: SessionStore.inMemory(customCwd),
});
console.log("Custom cwd session created");
customCwdSession.dispose();

const { session: specificToolsSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
	sessionManager: SessionStore.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
specificToolsSession.dispose();
