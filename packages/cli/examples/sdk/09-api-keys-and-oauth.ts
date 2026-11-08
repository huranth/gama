import { createAgentSession, ModelHub, SessionStore } from "@huranth/gama-harness";

const modelRuntime = await ModelHub.create();
const { session: defaultAuthSession } = await createAgentSession({
	sessionManager: SessionStore.inMemory(),
	modelRuntime,
});
console.log("Session with default model runtime");
defaultAuthSession.dispose();

const customRuntime = await ModelHub.create({
	authPath: "/tmp/my-app/auth.json",
	modelsPath: "/tmp/my-app/models.json",
});
const { session: customAuthSession } = await createAgentSession({
	sessionManager: SessionStore.inMemory(),
	modelRuntime: customRuntime,
});
console.log("Session with custom auth and models locations");
customAuthSession.dispose();

await modelRuntime.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const { session: runtimeKeySession } = await createAgentSession({
	sessionManager: SessionStore.inMemory(),
	modelRuntime,
});
console.log("Session with runtime API key override");
runtimeKeySession.dispose();
