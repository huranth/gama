import type { AgentMessage } from "@huranth/gama-agent-core";
import type { JsonObject } from "@huranth/gama-ai";
import { describe, expect, it } from "vitest";
import { buildCompactionMemory, outlineOf } from "../src/core/comp/memory.ts";
import { createFileOps } from "../src/core/comp/utils.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function call(id: string, name: string, args: JsonObject): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function result(
	id: string,
	name: string,
	text: string,
	options: { isError?: boolean } = {},
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: options.isError ?? false,
		timestamp: Date.now(),
	};
}

describe("buildCompactionMemory", () => {
	it("carries the newest read and no stale contents after an edit", () => {
		const messages: AgentMessage[] = [
			user("Fix the parser."),
			call("r1", "read", { path: "src/parser.ts" }),
			result("r1", "read", "export const version = 1;"),
			call("r2", "read", { path: "src/parser.ts" }),
			result("r2", "read", "export const version = 2;"),
		];

		const memory = buildCompactionMemory({ messages, fileOps: createFileOps() });

		expect(memory).toContain("## Requests");
		expect(memory).toContain("- Fix the parser.");
		expect(memory).toContain("src/parser.ts (read, 1 line)");
		expect(memory).toContain("version = 2");
		expect(memory).not.toContain("version = 1");
	});

	it("drops the contents of a read edited afterwards", () => {
		const fileOps = createFileOps();
		const messages: AgentMessage[] = [
			call("r1", "read", { path: "src/parser.ts" }),
			result(
				"r1",
				"read",
				["// header", "export function parse(input: string) {", "\treturn input;", "}"].join(
					"\n",
				),
			),
			call("e1", "edit", { path: "src/parser.ts" }),
			result("e1", "edit", "ok"),
		];
		fileOps.read.add("src/parser.ts");
		fileOps.edited.add("src/parser.ts");

		const memory = buildCompactionMemory({ messages, fileOps });

		expect(memory).toContain("src/parser.ts (edited)");
		expect(memory).toContain("edited after this read");
		expect(memory).toContain("L2 export function parse");
		expect(memory).not.toContain("return input;");
	});

	it("ignores a failed edit", () => {
		const fileOps = createFileOps();
		const messages: AgentMessage[] = [
			call("r1", "read", { path: "src/parser.ts" }),
			result("r1", "read", "export const version = 1;"),
			call("e1", "edit", { path: "src/parser.ts" }),
			result("e1", "edit", "Text not found", { isError: true }),
		];
		fileOps.edited.add("src/parser.ts");

		const memory = buildCompactionMemory({ messages, fileOps });

		expect(memory).not.toContain("(edited)");
		expect(memory).toContain("version = 1");
	});

	it("carries a read taken after an edit", () => {
		const fileOps = createFileOps();
		const messages: AgentMessage[] = [
			call("r1", "read", { path: "src/parser.ts" }),
			result("r1", "read", "export const version = 1;"),
			call("e1", "edit", { path: "src/parser.ts" }),
			result("e1", "edit", "ok"),
			call("r2", "read", { path: "src/parser.ts" }),
			result("r2", "read", "export const version = 2;"),
		];
		fileOps.edited.add("src/parser.ts");

		const memory = buildCompactionMemory({ messages, fileOps });

		expect(memory).toContain("edited then read");
		expect(memory).toContain("version = 2");
		expect(memory).not.toContain("version = 1");
	});

	it("adds the read offset to outline lines", () => {
		const messages: AgentMessage[] = [
			call("r1", "read", { path: "big.ts", offset: 100 }),
			result("r1", "read", "export function parse() {"),
			call("e1", "edit", { path: "big.ts" }),
			result("e1", "edit", "ok"),
		];

		const memory = buildCompactionMemory({ messages, fileOps: createFileOps() });

		expect(memory).toContain("L100 export function parse()");
	});

	it("uses a safe fence when the file has backticks", () => {
		const messages: AgentMessage[] = [
			call("r1", "read", { path: "README.md" }),
			result("r1", "read", ["```", "npm test", "```"].join("\n")),
		];

		const memory = buildCompactionMemory({ messages, fileOps: createFileOps() });

		expect(memory).toContain("````");
		expect(memory).toContain("npm test");
	});

	it("keeps powershell commands", () => {
		const messages: AgentMessage[] = [
			call("p1", "powershell", { command: "npm test" }),
			result("p1", "powershell", "failed", { isError: true }),
		];

		const memory = buildCompactionMemory({ messages, fileOps: createFileOps() });

		expect(memory).toContain("`npm test` failed");
	});

	it("keeps failed command errors and successful verification commands", () => {
		const messages: AgentMessage[] = [
			call("b1", "bash", { command: "npm test" }),
			result("b1", "bash", "2532 passed"),
			call("b2", "bash", { command: "npm run build" }),
			result("b2", "bash", "Error: unresolved import './missing.ts'", { isError: true }),
		];

		const memory = buildCompactionMemory({ messages, fileOps: createFileOps() });

		expect(memory).toContain("## Commands");
		expect(memory).toContain("- `npm test` ok");
		expect(memory).toContain("`npm run build` failed: Error: unresolved import './missing.ts'");
	});

	it("keeps answers the user gave", () => {
		const messages: AgentMessage[] = [
			call("q1", "ask_user", { questions: [{ question: "Which database?" }] }),
			result("q1", "ask_user", "Use Postgres"),
		];

		const memory = buildCompactionMemory({ messages, fileOps: createFileOps() });

		expect(memory).toContain("## Answers");
		expect(memory).toContain("- Use Postgres");
	});

	it("stays within the character budget", () => {
		const messages: AgentMessage[] = [
			user("Read the big file."),
			call("r1", "read", { path: "big.ts" }),
			result("r1", "read", "export const value = 1;\n".repeat(500)),
		];

		const memory = buildCompactionMemory({ messages, fileOps: createFileOps(), maxChars: 400 });

		expect(memory.length).toBeLessThanOrEqual(400);
	});

	it("outlines top-level declarations with line numbers", () => {
		const outline = outlineOf(
			["// a", "export function one() {", "}", "export class Two {", "}"].join("\n"),
		);

		expect(outline).toContain("L2 export function one()");
		expect(outline).toContain("L4 export class Two");
	});
});
