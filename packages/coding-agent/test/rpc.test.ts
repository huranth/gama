import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@huranth/gama-agent-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { type AnthropicMockServer, startAnthropicMockServer } from "./anthropic-mock.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Config.
function writeMockProviderConfig(agentDir: string, baseUrl: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				anthropic: {
					baseUrl,
					apiKey: "test-key",
					api: "anthropic-messages",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5 (mock)",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
							contextWindow: 200000,
							maxTokens: 8192,
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ anthropic: { type: "api_key", key: "test-key" } }),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 500 } }),
	);
}

describe("RPC mode", () => {
	let client: RpcClient;
	let sessionDir: string;
	let mockServer: AnthropicMockServer;

	beforeAll(async () => {
		mockServer = await startAnthropicMockServer();
	});

	afterAll(async () => {
		await mockServer.close();
	});

	beforeEach(() => {
		sessionDir = join(tmpdir(), `gama-rpc-test-${Date.now()}`);
		writeMockProviderConfig(sessionDir, mockServer.baseUrl);
		client = new RpcClient({
			cliPath: join(__dirname, "..", "dist", "cli.js"),
			cwd: join(__dirname, ".."),
			env: { GAMA_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	afterEach(async () => {
		await client.stop();
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true });
		}
	});

	test("should get state", async () => {
		await client.start();
		const state = await client.getState();

		expect(state.model).toBeDefined();
		expect(state.model?.provider).toBe("anthropic");
		expect(state.model?.id).toBe("claude-sonnet-4-5");
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
	}, 30000);

	test("should save messages to session file", async () => {
		await client.start();

		const events = await client.promptAndWait("Reply with just the word 'hello'");

		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThanOrEqual(2);

		await new Promise((resolve) => setTimeout(resolve, 200));

		const sessionsPath = join(sessionDir, "sessions");
		expect(existsSync(sessionsPath)).toBe(true);

		const sessionFiles = readdirSync(sessionsPath).filter((f) => f.endsWith(".gama"));
		expect(sessionFiles.length).toBe(1);

		const sessionContent = readFileSync(join(sessionsPath, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		expect(entries[0].type).toBe("session");

		const messages = entries.filter((e: { type: string }) => e.type === "message");
		expect(messages.length).toBeGreaterThanOrEqual(2);

		const roles = messages.map((m: { message: { role: string } }) => m.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		await client.start();

		await client.promptAndWait("Say hello");

		const result = await client.compact();
		expect(result.summary).toBeDefined();
		expect(result.tokensBefore).toBeGreaterThan(0);

		await new Promise((resolve) => setTimeout(resolve, 200));

		const sessionsPath = join(sessionDir, "sessions");
		const sessionFiles = readdirSync(sessionsPath).filter((f) => f.endsWith(".gama"));
		const sessionContent = readFileSync(join(sessionsPath, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const compactionEntries = entries.filter((e: { type: string }) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
		expect(compactionEntries[0].summary).toBeDefined();
	}, 120000);

	test("should execute bash command", async () => {
		await client.start();

		const result = await client.bash("echo hello");
		expect(result.output.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	}, 30000);

	test("should add bash output to context", async () => {
		await client.start();

		await client.promptAndWait("Say hi");

		const uniqueValue = `test-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		await new Promise((resolve) => setTimeout(resolve, 200));

		const sessionsPath = join(sessionDir, "sessions");
		const sessionFiles = readdirSync(sessionsPath).filter((f) => f.endsWith(".gama"));
		const sessionContent = readFileSync(join(sessionsPath, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const bashMessages = entries.filter(
			(e: { type: string; message?: { role: string } }) =>
				e.type === "message" && e.message?.role === "bashExecution",
		);
		expect(bashMessages.length).toBe(1);
		expect(bashMessages[0].message.output).toContain(uniqueValue);
	}, 90000);

	test("should include bash output in LLM context", async () => {
		await client.start();

		const uniqueValue = `unique-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		const events = await client.promptAndWait(
			"What was the exact output of the echo command I just ran? Reply with just the value, nothing else.",
		);

		const messageEndEvents = events.filter((e) => e.type === "message_end") as AgentEvent[];
		const assistantMessage = messageEndEvents.find(
			(e) => e.type === "message_end" && e.message?.role === "assistant",
		) as any;

		expect(assistantMessage).toBeDefined();

		const textContent = assistantMessage.message.content.find((c: any) => c.type === "text");
		expect(textContent?.text).toContain(uniqueValue);
	}, 90000);

	test("should set and get thinking level", async () => {
		await client.start();

		await client.setThinkingLevel("high");

		const state = await client.getState();
		expect(state.thinkingLevel).toBe("high");
	}, 30000);

	test("should cycle thinking level", async () => {
		await client.start();

		const initialState = await client.getState();
		const initialLevel = initialState.thinkingLevel;

		const result = await client.cycleThinkingLevel();
		expect(result).toBeDefined();
		expect(result!.level).not.toBe(initialLevel);

		const newState = await client.getState();
		expect(newState.thinkingLevel).toBe(result!.level);
	}, 30000);

	test("should get available thinking levels", async () => {
		await client.start();

		const levels = await client.getAvailableThinkingLevels();
		expect(levels.length).toBeGreaterThan(0);

		const state = await client.getState();
		expect(levels).toContain(state.thinkingLevel);

		const initialLevel = state.thinkingLevel;
		const cycled = await client.cycleThinkingLevel();
		if (cycled) {
			expect(levels).toContain(cycled.level);
			if (levels.length > 1) {
				expect(cycled.level).not.toBe(initialLevel);
			}
		}
	}, 30000);

	test("should get available models", async () => {
		await client.start();

		const models = await client.getAvailableModels();
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	}, 30000);

	test("should get session stats", async () => {
		await client.start();

		await client.promptAndWait("Hello");

		const stats = await client.getSessionStats();
		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	}, 90000);

	test("should create new session", async () => {
		await client.start();

		await client.promptAndWait("Hello");

		let state = await client.getState();
		expect(state.messageCount).toBeGreaterThan(0);

		await client.newSession();

		state = await client.getState();
		expect(state.messageCount).toBe(0);
	}, 90000);

	test("should export to HTML", async () => {
		await client.start();

		await client.promptAndWait("Hello");

		const result = await client.exportHtml();
		expect(result.path).toBeDefined();
		expect(result.path.endsWith(".html")).toBe(true);
		expect(existsSync(result.path)).toBe(true);
	}, 90000);

	test("should get last assistant text", async () => {
		await client.start();

		let text = await client.getLastAssistantText();
		expect(text).toBeUndefined();

		await client.promptAndWait("Reply with just: test123");

		text = await client.getLastAssistantText();
		expect(text).toContain("test123");
	}, 90000);

	test("should get session entries with since cursor", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		expect(entries.length).toBeGreaterThanOrEqual(2);
		for (const entry of entries) {
			expect(entry.id).toBeDefined();
		}
		expect(leafId).toBe(entries[entries.length - 1].id);

		const since = await client.getEntries(entries[0].id);
		expect(since.entries.map((e) => e.id)).toEqual(entries.slice(1).map((e) => e.id));
		expect(since.leafId).toBe(leafId);

		await expect(client.getEntries("nonexistent-id")).rejects.toThrow("Entry not found");
	}, 90000);

	test("should get session tree", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		const { tree, leafId: treeLeafId } = await client.getTree();
		expect(treeLeafId).toBe(leafId);

		expect(tree.length).toBe(1);
		const chainIds: string[] = [];
		let nodes = tree;
		while (nodes.length === 1) {
			chainIds.push(nodes[0].entry.id);
			nodes = nodes[0].children;
		}
		expect(nodes.length).toBe(0);
		expect(chainIds).toEqual(entries.map((e) => e.id));
	}, 90000);

	test("should retain pre-compaction entries in get_entries", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");
		const before = await client.getEntries();

		await client.compact();

		const after = await client.getEntries();
		expect(after.entries.slice(0, before.entries.length).map((e) => e.id)).toEqual(
			before.entries.map((e) => e.id),
		);
		expect(after.entries.some((e) => e.type === "compaction")).toBe(true);
	}, 120000);

	test("should set and get session name", async () => {
		await client.start();

		let state = await client.getState();
		expect(state.sessionName).toBeUndefined();

		await client.promptAndWait("Reply with just 'ok'");

		await client.setSessionName("my-test-session");

		state = await client.getState();
		expect(state.sessionName).toBe("my-test-session");

		await new Promise((resolve) => setTimeout(resolve, 200));

		const sessionsPath = join(sessionDir, "sessions");
		const sessionFiles = readdirSync(sessionsPath).filter((f) => f.endsWith(".gama"));
		const sessionContent = readFileSync(join(sessionsPath, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const sessionInfoEntries = entries.filter((e: { type: string }) => e.type === "session_info");
		expect(sessionInfoEntries.length).toBe(1);
		expect(sessionInfoEntries[0].name).toBe("my-test-session");
	}, 60000);
});
