import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "@huranth/gama-agent-core";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@huranth/gama-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { RunSession } from "../../../src/core/session/session.ts";
import { AuthStorage } from "../../../src/core/vault.ts";
import { convertToLlm } from "../../../src/core/msg.ts";
import { SessionStore } from "../../../src/core/sessions.ts";
import { SettingsStore } from "../../../src/core/settings.ts";
import { initTheme } from "../../../src/term/theme/theme.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../model-run-test-utils.ts";
import { createTestResourceLoader } from "../../test-helpers.ts";

describe("regression #5596: missing configured theme export", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		initTheme("dark");
	});

	it("exports with the active fallback theme when the configured theme is missing", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "gama-5596-"));
		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		let session: RunSession | undefined;
		cleanups.push(() => {
			session?.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		faux.setResponses([fauxAssistantMessage("hello")]);

		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const settingsManager = SettingsStore.inMemory({ theme: "missing-theme" });
		const sessionManager = SessionStore.create(tempDir, join(tempDir, "sessions"));
		const agent = new Runner({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
			convertToLlm,
			streamFn: streamSimple,
		});
		session = new RunSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("hi");
		initTheme(settingsManager.getTheme());

		const outputPath = join(tempDir, "export.html");
		await expect(session.exportToHtml(outputPath)).resolves.toBe(outputPath);
		expect(existsSync(outputPath)).toBe(true);
		expect(settingsManager.getTheme()).toBe("missing-theme");
	});
});
