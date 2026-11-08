import { createAgentSession, SessionStore, SettingsStore } from "@huranth/gama-harness";

const cwd = process.cwd();

const settingsManagerFromDisk = SettingsStore.create(cwd);
console.log(
	"Current settings:",
	JSON.stringify(settingsManagerFromDisk.getGlobalSettings(), null, 2),
);

const settingsManager = SettingsStore.create(cwd);
settingsManager.applyOverrides({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
});

const { session: customSettingsSession } = await createAgentSession({
	settingsManager,
	sessionManager: SessionStore.inMemory(),
});
console.log("Session created with custom settings");
customSettingsSession.dispose();

settingsManager.setDefaultThinkingLevel("low");
await settingsManager.flush();

const settingsErrors = settingsManager.drainErrors();
if (settingsErrors.length > 0) {
	for (const { scope, error } of settingsErrors) {
		console.warn(`Warning (${scope} settings): ${error.message}`);
	}
}

const inMemorySettings = SettingsStore.inMemory({
	compaction: { enabled: false },
	retry: { enabled: false },
});

const { session: testSession } = await createAgentSession({
	settingsManager: inMemorySettings,
	sessionManager: SessionStore.inMemory(),
});
console.log("Test session created with in-memory settings");
testSession.dispose();
