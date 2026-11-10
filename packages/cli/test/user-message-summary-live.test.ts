import { Runner } from "@huranth/gama-agent-core";
import { fauxAssistantMessage } from "@huranth/gama-ai";
import { registerFauxProvider, streamSimple } from "@huranth/gama-ai/compat";
import { describe, expect, it } from "vitest";
import { RunSession } from "../src/core/session/session.ts";
import { SessionStore } from "../src/core/sessions.ts";
import { SettingsStore } from "../src/core/settings.ts";
import { AuthStorage } from "../src/core/vault.ts";
import { PROMPT_SUMMARY_MIN_WORDS, UserMessageComponent } from "../src/term/parts/user-message.ts";
import { initTheme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createModelRegistry, getModelRuntime } from "./model-run-test-utils.ts";
import { createTestResourceLoader } from "./test-helpers.ts";

const SUMMARY = "Refactor the auth resolver and check the token refresh path.";

function makePrompt(words: number): string {
	return Array.from({ length: words }, (_, index) => `word${index}`).join(" ");
}

async function createSession() {
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage(SUMMARY), fauxAssistantMessage(SUMMARY)]);
	const model = faux.getModel();

	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createModelRegistry(authStorage);
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
		})),
	});

	const session = new RunSession({
		agent: new Runner({
			getApiKey: () => "faux-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "off",
			},
		}),
		sessionManager: SessionStore.inMemory(),
		settingsManager: SettingsStore.inMemory(),
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});
	return session;
}

describe("prompt summary live flow", () => {
	it("summarizes a long prompt with the session model and renders it in the left pane", async () => {
		initTheme("dark");
		const session = await createSession();
		try {
			const prompt = makePrompt(PROMPT_SUMMARY_MIN_WORDS + 1);
			const summary = await session.summarizePrompt(prompt);
			expect(summary).toBe(SUMMARY);
			const usage = session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "usage" && entry.kind === "prompt_summary");
			expect(usage).toBe(true);

			let calls = 0;
			const component = new UserMessageComponent(prompt);
			component.setPromptSummary({
				enabled: true,
				generate: (signal) => {
					calls++;
					return session.summarizePrompt(prompt, signal);
				},
			});

			const before = component.render(80).map(stripAnsi);
			expect(calls).toBe(0);
			expect(before.some((line) => line.includes("word0"))).toBe(true);
			const generateRow = before.findIndex((line) => line.includes("Generate"));
			expect(generateRow).toBeGreaterThanOrEqual(0);

			component.handleMouse({
				type: "click",
				button: "left",
				x: 78,
				y: generateRow,
				screenX: 78,
				screenY: generateRow,
				width: 80,
				height: before.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});

			let after: string[] = [];
			for (let attempt = 0; attempt < 50; attempt++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				after = component.render(80).map(stripAnsi);
				if (after.some((line) => line.includes(SUMMARY))) break;
			}
			expect(after.some((line) => line.includes("Refactor the auth"))).toBe(true);
			expect(calls).toBe(1);
			// Canvas below
			const summaryRow = after.findIndex((line) => line.includes("Refactor the auth"));
			const promptRow = after.findIndex((line) => line.includes("word0"));
			expect(summaryRow).toBeGreaterThan(promptRow);
			expect(after.some((line) => line.includes("Hide"))).toBe(true);

			const hideRow = after.findIndex((line) => line.includes("Hide"));
			component.handleMouse({
				type: "click",
				button: "left",
				x: 78,
				y: hideRow,
				screenX: 78,
				screenY: hideRow,
				width: 80,
				height: after.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			});
			const afterHide = component.render(80).map(stripAnsi);
			expect(afterHide.some((line) => line.includes("Refactor the auth"))).toBe(false);
			expect(afterHide.some((line) => line.includes("Show"))).toBe(true);
		} finally {
			session.dispose();
		}
	}, 30000);
});
