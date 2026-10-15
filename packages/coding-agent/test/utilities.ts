import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@huranth/gama-agent-core";
import { registerFauxProvider, streamSimple } from "@huranth/gama-ai/compat";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type {
	Extension,
	ExtensionFactory,
	InlineExtension,
	LoadExtensionsResult,
} from "../src/core/ext/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/ext/loader.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createCodingTools } from "../src/index.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

export const API_KEY = process.env.ANTHROPIC_API_KEY;

const AUTH_PATH = join(homedir(), ".gama", "agent", "auth.json");
type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type AuthCredential = ApiKeyCredential;

type AuthStorageData = Record<string, AuthCredential>;

function loadAuthStorage(): AuthStorageData {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(AUTH_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const storage = loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	return undefined;
}

export function hasAuthForProvider(provider: string): boolean {
	const storage = loadAuthStorage();
	return provider in storage;
}

export const GAMA_AGENT_DIR = join(homedir(), ".gama", "agent");

export function getRealAuthStorage(): AuthStorage {
	return AuthStorage.create(AUTH_PATH);
}

export function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

export function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

export function readSessionFileRoles(file: string): string[] {
	return readFileSync(file, "utf-8")
		.trim()
		.split("\n")
		.map((line) => {
			const record = JSON.parse(line);
			return record.message?.role ?? record.type;
		});
}

export interface TestSessionOptions {
	inMemory?: boolean;
	systemPrompt?: string;
	settingsOverrides?: Record<string, unknown>;
	// Options.
	fauxOptions?: Parameters<typeof registerFauxProvider>[0];
}

export interface TestSessionContext {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	faux: ReturnType<typeof registerFauxProvider>;
	cleanup: () => void;
}

export interface CreateTestExtensionsResultInput {
	factory: ExtensionFactory;
	path?: string;
}

type TestExtensionInput = InlineExtension | CreateTestExtensionsResultInput;

export async function createTestExtensionsResult(
	inputs: TestExtensionInput[],
	cwd = process.cwd(),
): Promise<LoadExtensionsResult> {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions: Extension[] = [];

	for (const [index, input] of inputs.entries()) {
		const isObject = typeof input !== "function";
		const hasName = isObject && "name" in input;
		const hasPath =
			isObject && "path" in input && typeof input.path === "string" && input.path !== "";
		const factory = isObject ? input.factory : input;
		const extensionPath = hasName
			? `<inline:${input.name}>`
			: hasPath
				? input.path
				: `<inline:${index + 1}>`;

		extensions.push(
			await loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath),
		);
	}

	return {
		extensions,
		errors: [],
		runtime,
	};
}

export interface CreateTestResourceLoaderOptions {
	extensionsResult?: LoadExtensionsResult;
}

export function createTestResourceLoader(
	options: CreateTestResourceLoaderOptions = {},
): ResourceLoader {
	const extensionsResult = options.extensionsResult ?? {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};

	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export async function createTestSession(
	options: TestSessionOptions = {},
): Promise<TestSessionContext> {
	const tempDir = join(tmpdir(), `gama-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider(options.fauxOptions);
	const model = faux.getModel();
	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a helpful assistant. Be extremely concise.",
			tools: createCodingTools(process.cwd()),
		},
		streamFn: streamSimple,
	});

	const sessionManager = options.inMemory
		? SessionManager.inMemory()
		: SessionManager.create(tempDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	if (options.settingsOverrides) {
		settingsManager.applyOverrides(options.settingsOverrides);
	}

	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createModelRegistry(authStorage, tempDir);
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
			inputLimits: registeredModel.inputLimits,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	session.subscribe(() => {});

	const cleanup = () => {
		session.dispose();
		faux.unregister();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	};

	return { session, sessionManager, tempDir, cleanup, faux };
}

export function buildTestTree(
	session: SessionManager,
	structure: {
		messages: Array<{ role: "user" | "assistant"; text: string; branchFrom?: string }>;
	},
): Map<string, string> {
	const ids = new Map<string, string>();

	for (const msg of structure.messages) {
		if (msg.branchFrom) {
			const branchFromId = ids.get(msg.branchFrom);
			if (!branchFromId) {
				throw new Error(`Cannot branch from unknown entry: ${msg.branchFrom}`);
			}
			session.branch(branchFromId);
		}

		const id =
			msg.role === "user"
				? session.appendMessage(userMsg(msg.text))
				: session.appendMessage(assistantMsg(msg.text));

		ids.set(msg.text, id);
	}

	return ids;
}
