import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@huranth/gama-ai/compat";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HAND_KINDS, HAND_SYSTEM_PROMPT, handKindLabel } from "../src/core/hands.ts";
import { createAgentSession } from "../src/core/kit.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionStore } from "../src/core/sessions.ts";
import { SettingsStore } from "../src/core/settings.ts";

describe("hands session wiring", () => {
	let tempDir = "";
	let agentDir = "";

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "gama-hands-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(enableHands?: boolean, appendSystemPrompt?: string) {
		const settingsManager = SettingsStore.inMemory({ defaultTools: ["read"] });
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionStore.inMemory(tempDir),
			resourceLoader,
			...(enableHands ? { enableHands: true } : {}),
			...(appendSystemPrompt ? { appendSystemPrompt } : {}),
		});
		return session;
	}

	test("defines specialized hand roles", () => {
		expect(Object.keys(HAND_KINDS)).toEqual(["scout", "digger", "runner", "critic", "builder"]);
		expect(handKindLabel("scout")).toBe("scout hand");
		expect(HAND_KINDS.scout.tools).toEqual(["read", "grep", "find", "ls", "outline"]);
		expect(HAND_KINDS.runner.tools).toContain("bash");
		expect(HAND_KINDS.runner.prompt).toContain('"output"');
		expect(HAND_KINDS.runner.prompt).not.toContain("outputTail");
		expect(HAND_KINDS.runner.prompt).toContain("complete command output");
		expect(HAND_KINDS.critic.description).toContain("independently verifies");
		expect(HAND_KINDS.critic.description).toContain("after a scout or digger");
		expect(HAND_KINDS.critic.prompt).toContain("widen scope");
		expect(HAND_KINDS.critic.prompt).toContain("confirmed, refuted, or unverified");
		expect(HAND_SYSTEM_PROMPT).toContain("Never truncate");
		expect(handKindLabel("builder")).toBe("builder hand");
		expect(HAND_KINDS.builder.tools).toBeUndefined();
	});

	test("does not add hands by default", async () => {
		const session = await createSession();
		expect(session.getActiveToolNames()).not.toContain("hands");
		expect(session.systemPrompt).not.toContain("- hands:");
		expect(session.systemPrompt).not.toContain("<delegation>");
		session.dispose();
	});

	test("appends the compact hand reply style", async () => {
		const session = await createSession(false, HAND_SYSTEM_PROMPT);
		expect(session.systemPrompt).toContain("compact handoff checkpoint");
		expect(session.systemPrompt).toContain("no offers to continue");
		expect(session.systemPrompt).toContain("1-3 plain sentences");
		expect(session.systemPrompt).toContain("Never truncate");
		session.dispose();
	});

	test("adds hands when enabled", async () => {
		const session = await createSession(true);
		expect(session.getActiveToolNames()).toContain("hands");
		expect(session.systemPrompt).toContain("- hands:");
		expect(session.systemPrompt).toContain("<delegation>");
		expect(session.systemPrompt).toContain("Hands are your default workers");
		expect(session.systemPrompt).toContain("Prefer hands for any task");
		expect(session.systemPrompt).toContain("explicitly says");
		expect(session.systemPrompt).toContain("Route by role");
		expect(session.systemPrompt).toContain("start critics on the highest-impact");
		expect(session.systemPrompt).toContain("one subsystem or one question");
		expect(session.getToolDefinition("hands")?.description).toContain(
			"default workers for real work",
		);
		expect(session.getToolDefinition("hands")?.description).toContain("role-bound workers");
		expect(session.getToolDefinition("hands")?.description).toContain("after a scout or digger");
		expect(session.getToolDefinition("hands")?.description).toContain("Action talk");
		expect(session.getToolDefinition("hands")?.description).toContain("scout hand");
		expect(session.getToolDefinition("hands")?.description).toContain("builder hand");
		session.dispose();
	});
});
