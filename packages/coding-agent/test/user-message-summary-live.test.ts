import { Agent } from "@huranth/gama-agent-core";
import { fauxAssistantMessage } from "@huranth/gama-ai";
import { registerFauxProvider, streamSimple } from "@huranth/gama-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	PROMPT_SUMMARY_MIN_WORDS,
	UserMessageComponent,
} from "../src/modes/tui/parts/user-message.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

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

	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "faux-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "off",
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
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
			expect(before[before.length - 1].trimEnd().endsWith("Generate")).toBe(true);
			expect(before.some((line) => line.includes("word0"))).toBe(true);

			component.handleMouse({
				type: "click",
				button: "left",
				x: 78,
				y: before.length - 1,
				screenX: 78,
				screenY: before.length - 1,
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
			expect(after.some((line) => line.trimEnd().endsWith("Hide"))).toBe(true);

			// Double click
			component.handleMouse({
				type: "click",
				button: "left",
				x: 10,
				y: summaryRow,
				screenX: 10,
				screenY: summaryRow,
				width: 80,
				height: after.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 2,
			});
			const collapsed = component.render(80).map(stripAnsi);
			expect(collapsed.some((line) => line.includes("Refactor the auth"))).toBe(false);
			expect(collapsed[collapsed.length - 1].trimEnd().endsWith("Show")).toBe(true);
		} finally {
			session.dispose();
		}
	}, 30000);
});
