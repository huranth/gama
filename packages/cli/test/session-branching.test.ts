import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@huranth/gama-ai";
import { registerFauxProvider } from "@huranth/gama-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelHub } from "../src/core/model-run.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type SessionRuntime,
} from "../src/core/session/runtime.ts";
import type { RunSession } from "../src/core/session/session.ts";
import { SessionStore } from "../src/core/sessions.ts";
import { AuthStorage } from "../src/core/vault.ts";

// Turns
const conversation = (target: RunSession) =>
	target.messages.filter((message) => message.role !== "system");

describe("RunSession forking", () => {
	let session: RunSession;
	let runtimeHost: SessionRuntime;
	let tempDir: string;
	let sessionManager: SessionStore;
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
		sessionManager = noSession ? SessionStore.inMemory(tempDir) : SessionStore.create(tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));

		const modelRuntime = await ModelHub.create({
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

	it("allow forking from single message", async () => {
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

	it("support in-memory forking in --no-session mode", async () => {
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

	it("fork from middle of conversation", async () => {
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
