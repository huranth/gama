import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@huranth/gama-ai";
import { registerFauxProvider } from "@huranth/gama-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

// Turns.
const conversation = (target: AgentSession) =>
	target.messages.filter((message) => message.role !== "system");

describe("AgentSession forking", () => {
	let session: AgentSession;
	let runtimeHost: AgentSessionRuntime;
	let tempDir: string;
	let sessionManager: SessionManager;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `gama-branching-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		faux = registerFauxProvider();
	});

	afterEach(async () => {
		if (runtimeHost) {
			await runtimeHost.dispose();
		}
		faux.unregister();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(noSession: boolean = false) {
		const model = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage("hello"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		sessionManager = noSession
			? SessionManager.inMemory(tempDir)
			: SessionManager.create(tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));

		const modelRuntime = await ModelRuntime.create({
			authPath: join(tempDir, "auth.json"),
			modelsPath: join(tempDir, "models.json"),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel: any) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				inputLimits: registeredModel.inputLimits,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const servicesOptions = {
			agentDir: tempDir,
			authStorage,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...servicesOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
					tools: ["read", "bash", "edit", "write"],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		session = runtimeHost.session;
		session.subscribe(() => {});
		await session.bindExtensions({});
		return session;
	}

	it("should allow forking from single message", async () => {
		await createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hello");

		expect(conversation(session)).toHaveLength(0);
		expect(session.sessionFile).not.toBeNull();
		expect(existsSync(session.sessionFile!)).toBe(false);
	});

	it("should support in-memory forking in --no-session mode", async () => {
		await createSession(true);

		expect(session.sessionFile).toBeUndefined();

		await session.prompt("Say hi");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(session.messages.length).toBeGreaterThan(0);

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hi");

		expect(conversation(session)).toHaveLength(0);
		expect(session.sessionFile).toBeUndefined();
	});

	it("should fork from middle of conversation", async () => {
		await createSession();

		await session.prompt("Say one");
		await session.agent.waitForIdle();

		await session.prompt("Say two");
		await session.agent.waitForIdle();

		await session.prompt("Say three");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(3);

		const secondMessage = userMessages[1];
		const result = await runtimeHost.fork(secondMessage.entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say two");

		const turns = conversation(session);
		expect(turns).toHaveLength(2);
		expect(turns[0].role).toBe("user");
		expect(turns[1].role).toBe("assistant");
	}, 60000);
});
