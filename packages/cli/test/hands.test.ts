import type { AgentMessage } from "@huranth/gama-agent-core";
import { describe, expect, test, vi } from "vitest";
import {
	buildHandTranscript,
	createHandsTool,
	HAND_KINDS,
	type HandKind,
	type HandSession,
	type HandsEvent,
	type HandsTool,
	MAX_HANDS,
} from "../src/core/hands.ts";

interface FakeSessionOptions {
	failOn?: number;
	gateFirstPrompt?: Promise<void>;
	gateAfterAssistant?: Promise<void>;
	usage?: Record<string, unknown>;
	reply?: string;
	continuationReply?: string;
	stopReason?: string;
}

function createFakeSession(options: FakeSessionOptions = {}): HandSession {
	const messages: AgentMessage[] = [];
	let promptCount = 0;
	const listeners = new Set<(event: unknown) => void>();
	const emit = (event: unknown) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		agent: {
			get state() {
				return { messages, streamingMessage: undefined };
			},
		},
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(task: string) {
			promptCount++;
			const user = {
				role: "user",
				content: [{ type: "text", text: task }],
				timestamp: Date.now(),
			} as AgentMessage;
			messages.push(user);
			emit({ type: "message_start", message: user });
			emit({ type: "message_end", message: user });

			if (options.gateFirstPrompt && promptCount === 1) {
				await options.gateFirstPrompt;
			}
			if (options.failOn === promptCount) throw new Error("hand broke");

			const assistant = {
				role: "assistant",
				content: [
					{
						type: "text",
						text:
							promptCount === 1
								? (options.reply ?? `finished ${task}`)
								: (options.continuationReply ?? `finished ${task}`),
					},
				],
				provider: "test",
				model: "test/model",
				usage: options.usage,
				timestamp: Date.now(),
				stopReason: promptCount === 1 ? (options.stopReason ?? "end") : "end",
			} as unknown as AgentMessage;
			messages.push(assistant);
			emit({ type: "message_start", message: assistant });
			emit({ type: "message_end", message: assistant });
			if (options.gateAfterAssistant) await options.gateAfterAssistant;
			emit({ type: "agent_end" });
		},
		abort() {},
		dispose() {
			listeners.clear();
		},
	};

	return session as unknown as HandSession;
}

function execute(tool: HandsTool, params: Parameters<HandsTool["execute"]>[1]) {
	return tool.execute("call", params, undefined, undefined, {} as never);
}

describe("hands", () => {
	test("carries thinking timings into the transcript", () => {
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "look around" }],
			timestamp: 7,
			stopReason: "stop",
		} as unknown as AgentMessage;
		const thinking = new Map([[7, [{ startedAt: 10, endedAt: 20 }]]]);

		const transcript = buildHandTranscript([message], undefined, thinking);
		const assistant = transcript.find((item) => item.role === "assistant");

		expect(assistant?.role === "assistant" ? assistant.thinking : undefined).toEqual([
			{ startedAt: 10, endedAt: 20 },
		]);
	});

	test("starts live hands, waits, then talks follow-ups", async () => {
		const events: HandsEvent[] = [];
		const created: Array<{ index: number; kind: HandKind }> = [];
		let releaseFirst: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const tool = createHandsTool({
			emit: (event) => events.push(event),
			createSession: async (index, kind) => {
				created.push({ index, kind });
				return createFakeSession({ gateFirstPrompt: index === 0 ? gate : undefined });
			},
		});

		const started = await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "check the login flow" } },
				{ kind: "builder", input: { goal: "check the logout flow" } },
			],
		});

		expect(created).toEqual([
			{ index: 0, kind: "scout" },
			{ index: 1, kind: "builder" },
		]);
		expect(events[0]?.type).toBe("hands_started");
		const startedEvent = events[0];
		if (startedEvent?.type !== "hands_started") throw new Error("missing start event");
		expect(startedEvent.hands.map((hand) => hand.title)).toEqual(["Hand 1", "Hand 2"]);
		expect(startedEvent.hands.map((hand) => hand.kind)).toEqual(["scout", "builder"]);
		expect(started.details.hands[0]?.status).toBe("running");
		if (started.content[0]?.type === "text") {
			expect(started.content[0].text).toContain("Hand 1 · scout hand started");
			expect(started.content[0].text).toContain('action "wait"');
		}

		releaseFirst();
		const waited = await execute(tool, { action: "wait" });
		expect(waited.details.hands.some((hand) => hand.status === "done")).toBe(true);

		const first = await execute(tool, { action: "wait", hand: "Hand 1" });
		const second = await execute(tool, { action: "wait", hand: "Hand 2" });
		const firstHand = first.details.hands[0]!;
		const secondHand = second.details.hands[0]!;
		expect([firstHand.status, secondHand.status]).toEqual(["done", "done"]);
		expect(firstHand.result).toContain("finished Role: scout");
		expect(firstHand.transcript.some((item) => item.role === "user")).toBe(true);
		if (first.content[0]?.type === "text") {
			expect(first.content[0].text).toContain("Hand 1 · scout hand (done)");
		}
		if (second.content[0]?.type === "text") {
			expect(second.content[0].text).toContain("Hand 2 · builder hand (done)");
		}

		const talked = await execute(tool, {
			action: "talk",
			hand: "Hand 1",
			message: "go deeper",
		});
		const hand = talked.details.hands[0]!;
		expect(hand.result).toBe("finished go deeper");
		expect(hand.transcript.filter((item) => item.role === "user")).toHaveLength(2);
		const last = hand.transcript.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			const text = last.message.content.find((block) => block.type === "text");
			expect(text?.type === "text" ? text.text : "").toBe("finished go deeper");
		}
		if (talked.content[0]?.type === "text") {
			expect(talked.content[0].text).toContain("finished go deeper");
		}

		const finished = await execute(tool, { action: "finish" });
		expect(finished.details.hands.map((hand) => hand.status)).toEqual(["done", "done"]);
		if (finished.content[0]?.type === "text") {
			expect(finished.content[0].text).toBe("Closed Hand 1, Hand 2.");
		}
		expect((await execute(tool, { action: "wait" })).content[0]?.type).toBe("text");
		tool.dispose();
	});

	test("returns a complete artifact for a single hand", async () => {
		const reply = "x".repeat(20_000);
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ reply }),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map it" } }],
		});
		const waited = await execute(tool, { action: "wait", hand: "Hand 1" });
		const text = waited.content[0]?.type === "text" ? waited.content[0].text : "";

		expect(text).toContain(reply);
		expect(text).not.toContain("showing characters");
		tool.dispose();
	});

	test("returns complete artifacts for every hand kind", async () => {
		const replies = new Map<HandKind, string>();
		const tool = createHandsTool({
			emit: () => {},
			createSession: async (_index, kind) => {
				const reply = `${kind}:${"x".repeat(14_000)}`;
				replies.set(kind, reply);
				return createFakeSession({ reply });
			},
		});

		await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "map it" } },
				{ kind: "digger", input: { target: "src", question: "trace it" } },
				{ kind: "runner", input: { command: "npm test" } },
				{ kind: "critic", input: { targets: ["src"] } },
				{ kind: "builder", input: { goal: "fix it" } },
			],
		});

		for (const [index, kind] of (Object.keys(HAND_KINDS) as HandKind[]).entries()) {
			const waited = await execute(tool, { action: "wait", hand: `Hand ${index + 1}` });
			const text = waited.content[0]?.type === "text" ? waited.content[0].text : "";
			expect(replies.get(kind)).toBeDefined();
			expect(text).toContain(replies.get(kind)!);
			expect(text).not.toContain("showing characters");
		}

		tool.dispose();
	});

	test("continues a hand reply cut off by the output limit", async () => {
		const first = 'Mapped it.\n\n```json\n{"files":[';
		const second = '{"path":"src/a.ts","purpose":"entry"}],"symbols":[],"entryPoints":[]}\n```';
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () =>
				createFakeSession({
					reply: first,
					continuationReply: second,
					stopReason: "length",
				}),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map it" } }],
		});
		const waited = await execute(tool, { action: "wait", hand: "Hand 1" });
		const hand = waited.details.hands[0]!;
		expect(hand.status).toBe("done");
		expect(hand.result).toBe(
			'{"files":[{"path":"src/a.ts","purpose":"entry"}],"symbols":[],"entryPoints":[]}',
		);

		const text = waited.content[0]?.type === "text" ? waited.content[0].text : "";
		expect(text).toContain('"src/a.ts"');
		expect(text).not.toContain("showing characters");
		tool.dispose();
	});

	test("keeps a readable summary in the transcript and only JSON for the coordinator", async () => {
		const reply =
			"Mapped the CLI entry. The boot path starts in cli.ts.\n\n" +
			'```json\n{"files":[{"path":"cli.ts","purpose":"entry"}],"symbols":[],"entryPoints":["cli.ts"]' +
			"}\n```";
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ reply }),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map it" } }],
		});
		const waited = await execute(tool, { action: "wait", hand: "Hand 1" });
		const hand = waited.details.hands[0]!;
		expect(hand.result).toBe(
			'{"files":[{"path":"cli.ts","purpose":"entry"}],"symbols":[],"entryPoints":["cli.ts"]}',
		);

		const last = hand.transcript.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			const text = last.message.content.find((block) => block.type === "text");
			expect(text?.type === "text" ? text.text : "").toContain("Mapped the CLI entry.");
		}

		const content = waited.content[0]?.type === "text" ? waited.content[0].text : "";
		expect(content).toContain('"files"');
		expect(content).not.toContain("Mapped the CLI entry.");
		tool.dispose();
	});

	test("returns complete long artifacts and supports offset reads", async () => {
		const reply = "a".repeat(45_000);
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ reply }),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map it" } }],
		});
		const waited = await execute(tool, { action: "wait", hand: "Hand 1" });
		const first = waited.content[0]?.type === "text" ? waited.content[0].text : "";
		expect(first).toContain(reply);
		expect(first).not.toContain("showing characters");

		const rest = await execute(tool, {
			action: "read",
			hand: "Hand 1",
			offset: 40_000,
		});
		const second = rest.content[0]?.type === "text" ? rest.content[0].text : "";
		expect(second).toContain("a".repeat(5_000));
		expect(second).not.toContain("showing characters");

		const beyond = await execute(tool, {
			action: "read",
			hand: "Hand 1",
			offset: 60_000,
		});
		const end = beyond.content[0]?.type === "text" ? beyond.content[0].text : "";
		expect(end).toContain("[no more: artifact is 45000 characters.]");

		tool.dispose();
	});

	test("rejects a bad read window and honors a large limit", async () => {
		const reply = "b".repeat(45_000);
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ reply }),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map it" } }],
		});
		await execute(tool, { action: "wait", hand: "Hand 1" });

		const bad = await execute(tool, {
			action: "read",
			hand: "Hand 1",
			offset: -1,
		});
		expect(bad.isError).toBe(true);
		const badText = bad.content[0]?.type === "text" ? bad.content[0].text : "";
		expect(badText).toContain("offset must be a non-negative integer");

		const clamped = await execute(tool, {
			action: "read",
			hand: "Hand 1",
			limit: 100_000,
		});
		const clampedText = clamped.content[0]?.type === "text" ? clamped.content[0].text : "";
		expect(clampedText).toContain("b".repeat(45_000));
		expect(clampedText).not.toContain("offset 40000");

		tool.dispose();
	});

	test("reads a running hand without waiting", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ gateFirstPrompt: gate }),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "slow" } }],
		});
		const read = await execute(tool, { action: "read", hand: "Hand 1" });
		const text = read.content[0]?.type === "text" ? read.content[0].text : "";
		expect(text).toContain("Still working.");

		release();
		await execute(tool, { action: "wait", hand: "Hand 1" });
		tool.dispose();
	});

	test("merges overlapping scout artifacts", async () => {
		const replies = [
			JSON.stringify({
				files: [{ path: "src/a.ts", purpose: "a" }],
				symbols: [{ name: "A", path: "src/a.ts" }],
				entryPoints: ["src/index.ts"],
			}),
			JSON.stringify({
				files: [
					{ path: "src/a.ts", purpose: "a" },
					{ path: "src/b.ts", purpose: "b" },
				],
				symbols: [
					{ name: "A", path: "src/a.ts" },
					{ name: "B", path: "src/b.ts" },
				],
				entryPoints: ["src/index.ts", "src/cli.ts"],
			}),
		];
		const tool = createHandsTool({
			emit: () => {},
			createSession: async (index) => createFakeSession({ reply: replies[index]! }),
		});

		await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "map" } },
				{ kind: "scout", input: { root: "src/core", question: "map deeper" } },
			],
		});
		await execute(tool, { action: "wait", hand: "Hand 1" });
		await execute(tool, { action: "wait", hand: "Hand 2" });

		const merged = await execute(tool, { action: "merge" });
		const text = merged.content[0]?.type === "text" ? merged.content[0].text : "";
		const value = JSON.parse(text) as {
			scout: { files: unknown[]; symbols: unknown[]; entryPoints: unknown[] };
			unparsed?: string[];
		};
		expect(value.scout.files).toHaveLength(2);
		expect(value.scout.symbols).toHaveLength(2);
		expect(value.scout.entryPoints).toHaveLength(2);
		expect(value.unparsed).toBeUndefined();

		tool.dispose();
	});

	test("reports unparsed artifacts when merging", async () => {
		const replies = [
			JSON.stringify({ files: [{ path: "src/a.ts" }], symbols: [], entryPoints: [] }),
			"this is prose, not JSON",
		];
		const tool = createHandsTool({
			emit: () => {},
			createSession: async (index) => createFakeSession({ reply: replies[index]! }),
		});

		await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "map" } },
				{ kind: "scout", input: { root: "src/core", question: "map deeper" } },
			],
		});
		await execute(tool, { action: "wait", hand: "Hand 1" });
		await execute(tool, { action: "wait", hand: "Hand 2" });

		const merged = await execute(tool, { action: "merge" });
		const text = merged.content[0]?.type === "text" ? merged.content[0].text : "";
		const value = JSON.parse(text) as { unparsed?: string[] };
		expect(value.unparsed).toEqual(["Hand 2"]);

		tool.dispose();
	});

	test("reports when nothing is mergeable", async () => {
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ reply: "this is prose, not JSON" }),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map" } }],
		});
		await execute(tool, { action: "wait", hand: "Hand 1" });

		const merged = await execute(tool, { action: "merge" });
		const text = merged.content[0]?.type === "text" ? merged.content[0].text : "";
		expect(text).toContain("No mergeable artifacts");
		expect(text).toContain("Hand 1");

		tool.dispose();
	});

	test("seeds shared context and warns about overlapping roots", async () => {
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession(),
		});

		const started = await execute(tool, {
			action: "start",
			context: "The login flow was already traced; skip it.",
			hands: [
				{ kind: "scout", input: { root: "./src", question: "map" } },
				{ kind: "scout", input: { root: "src/core", question: "map deeper" } },
			],
		});

		expect(started.details.hands[0]?.task).toContain(
			"Shared context:\nThe login flow was already traced; skip it.",
		);
		const text = started.content[0]?.type === "text" ? started.content[0].text : "";
		expect(text).toContain("Overlap warning:");
		expect(text).toContain("Hand 1 (src)");
		expect(text).toContain("Hand 2 (src/core)");

		tool.dispose();
	});

	test("wait returns on the first finished hand", async () => {
		let releaseFirst: () => void = () => {};
		let releaseSecond: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const tool = createHandsTool({
			emit: () => {},
			createSession: async (index) =>
				createFakeSession({ gateFirstPrompt: index === 0 ? firstGate : secondGate }),
		});

		await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "first" } },
				{ kind: "builder", input: { goal: "second" } },
			],
		});

		const next = execute(tool, { action: "wait" });
		let settled = false;
		void next.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		releaseFirst();
		const waited = await next;
		const hands = waited.details.hands;
		const firstId = hands.find((hand) => hand.title === "Hand 1")?.id;
		expect(hands.find((hand) => hand.title === "Hand 1")?.status).toBe("done");
		expect(hands.find((hand) => hand.title === "Hand 2")?.status).toBe("running");
		expect(waited.details.delivered).toEqual([firstId]);
		expect(waited.details.collected).toEqual([firstId]);
		const text = waited.content[0]?.type === "text" ? waited.content[0].text : "";
		expect(text).toContain("Hand 1 · scout hand (done)");
		expect(text).not.toContain("Hand 2 · builder hand (running)");
		expect(text).toContain("1 hand is still running");

		const second = execute(tool, { action: "wait" });
		let secondSettled = false;
		void second.then(() => {
			secondSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(secondSettled).toBe(false);

		releaseSecond();
		const rest = await second;
		const secondId = rest.details.hands.find((hand) => hand.title === "Hand 2")?.id;
		expect(rest.details.hands.find((hand) => hand.title === "Hand 2")?.status).toBe("done");
		expect(rest.details.delivered).toEqual([secondId]);
		expect(rest.details.collected).toEqual([firstId, secondId]);
		const restText = rest.content[0]?.type === "text" ? rest.content[0].text : "";
		expect(restText).toContain("Hand 2 · builder hand (done)");

		const third = await execute(tool, { action: "wait" });
		expect(third.details.delivered).toEqual([]);
		expect(third.details.collected).toEqual([firstId, secondId]);
		const thirdText = third.content[0]?.type === "text" ? third.content[0].text : "";
		expect(thirdText).toContain("No new hand results");
		tool.dispose();
	});

	test("wakes the parent as each hand finishes", async () => {
		const wakes: string[] = [];
		let releaseSecond: () => void = () => {};
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const tool = createHandsTool({
			emit: () => {},
			wake: (text) => wakes.push(text),
			createSession: async (index) =>
				index === 0 ? createFakeSession() : createFakeSession({ gateFirstPrompt: secondGate }),
		});

		await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "first" } },
				{ kind: "builder", input: { goal: "second" } },
			],
		});

		await vi.waitFor(() => expect(wakes).toHaveLength(1));
		expect(wakes[0]).toContain("Hand 1 · scout hand (done)");
		expect(wakes[0]).toContain("finished Role: scout");
		expect(wakes[0]).not.toContain("Hand 2");

		releaseSecond();
		await execute(tool, { action: "wait", hand: "Hand 2" });
		expect(wakes).toHaveLength(2);
		expect(wakes[1]).toContain("Hand 2 · builder hand (done)");
		tool.dispose();
	});

	test("batch wait returns a finished hand even after its wake was sent", async () => {
		let releaseSecond: () => void = () => {};
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const wakes: string[] = [];
		const tool = createHandsTool({
			emit: () => {},
			wake: (text) => wakes.push(text),
			cancelWake: () => true,
			createSession: async (index) =>
				index === 0 ? createFakeSession() : createFakeSession({ gateFirstPrompt: secondGate }),
		});

		const started = await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "first" } },
				{ kind: "builder", input: { goal: "second" } },
			],
		});
		const firstId = started.details.hands[0]!.id;
		await vi.waitFor(() => expect(wakes).toHaveLength(1));

		const waited = await execute(tool, { action: "wait" });
		expect(waited.details.delivered).toEqual([firstId]);
		expect(waited.details.collected).toEqual([firstId]);
		const text = waited.content[0]?.type === "text" ? waited.content[0].text : "";
		expect(text).toContain("Hand 1 · scout hand (done)");
		expect(text).not.toContain("No new hand results");

		releaseSecond();
		await execute(tool, { action: "wait" });
		tool.dispose();
	});

	test("batch wait does not redeliver a wake the coordinator already consumed", async () => {
		let releaseSecond: () => void = () => {};
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const wakes: string[] = [];
		const tool = createHandsTool({
			emit: () => {},
			wake: (text) => wakes.push(text),
			cancelWake: () => false,
			createSession: async (index) =>
				index === 0 ? createFakeSession() : createFakeSession({ gateFirstPrompt: secondGate }),
		});

		await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "first" } },
				{ kind: "builder", input: { goal: "second" } },
			],
		});
		releaseSecond();
		await vi.waitFor(() => expect(wakes).toHaveLength(2));

		const waited = await execute(tool, { action: "wait" });
		expect(waited.details.delivered).toEqual([]);
		const text = waited.content[0]?.type === "text" ? waited.content[0].text : "";
		expect(text).toContain("No new hand results");
		tool.dispose();
	});

	test("cancels queued wakes when a result is read or hands close", async () => {
		const wakes: string[] = [];
		const cancels: string[] = [];
		const tool = createHandsTool({
			emit: () => {},
			wake: (text) => wakes.push(text),
			cancelWake: (handId) => {
				cancels.push(handId);
				return true;
			},
			createSession: async () => createFakeSession(),
		});

		const started = await execute(tool, {
			action: "start",
			hands: [
				{ kind: "scout", input: { root: "src", question: "one" } },
				{ kind: "scout", input: { root: "src", question: "two" } },
			],
		});
		const ids = started.details.hands.map((hand) => hand.id);
		await vi.waitFor(() => expect(wakes).toHaveLength(2));

		await execute(tool, { action: "read", hand: "Hand 1" });
		expect(cancels).toContain(ids[0]);

		cancels.length = 0;
		await execute(tool, { action: "finish" });
		expect(cancels).toEqual(expect.arrayContaining(ids));
		tool.dispose();
	});

	test("cancels a queued wake when wait delivers the hand", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const wakes: string[] = [];
		const cancels: string[] = [];
		const tool = createHandsTool({
			emit: () => {},
			wake: (text) => wakes.push(text),
			cancelWake: (handId) => {
				cancels.push(handId);
				return true;
			},
			createSession: async () => createFakeSession({ gateFirstPrompt: gate }),
		});

		const started = await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "wait" } }],
		});
		const id = started.details.hands[0]!.id;
		const waited = execute(tool, { action: "wait", hand: "Hand 1" });
		release();
		await waited;
		await vi.waitFor(() => expect(wakes).toHaveLength(1));
		expect(cancels).toContain(id);
		tool.dispose();
	});

	test("keeps hands running when a listener throws", async () => {
		const events: HandsEvent[] = [];
		const tool = createHandsTool({
			emit: (event) => {
				events.push(event);
				throw new Error("listener broke");
			},
			createSession: async () => createFakeSession(),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "keep going" } }],
		});

		const waited = await execute(tool, { action: "wait" });
		expect(waited.details.hands[0]?.status).toBe("done");

		await vi.waitFor(() => {
			expect(events.some((event) => event.type === "hands_finished")).toBe(true);
		});

		tool.dispose();
	});

	test("marks a throwing hand as failed without failing its sibling", async () => {
		const wakes: string[] = [];
		const tool = createHandsTool({
			emit: () => {},
			wake: (text) => wakes.push(text),
			cancelWake: () => true,
			createSession: async (index) =>
				index === 0 ? createFakeSession({ failOn: 1 }) : createFakeSession(),
		});

		await execute(tool, {
			action: "start",
			hands: [
				{ kind: "builder", input: { goal: "bad hand" } },
				{ kind: "builder", input: { goal: "good hand" } },
			],
		});
		const waited = await execute(tool, { action: "wait" });

		expect(waited.details.hands[0]?.status).toBe("failed");
		expect(waited.details.hands[0]?.error).toContain("hand broke");
		expect(waited.details.hands[1]?.status).toBe("done");
		const failedText = waited.content[0]?.type === "text" ? waited.content[0].text : "";
		expect(failedText).toContain("Reason: hand broke");
		expect(failedText).toContain('Next: Use action "talk"');
		expect(wakes.some((text) => text.includes("(failed)") && text.includes("hand broke"))).toBe(
			true,
		);
		tool.dispose();
	});

	test("reports a hand that fails to start with Reason and Next", async () => {
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => {
				throw new Error("provider unavailable");
			},
		});

		const started = await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map it" } }],
		});
		const text = started.content[0]?.type === "text" ? started.content[0].text : "";
		expect(started.isError).toBe(false);
		expect(text).toContain("failed to start");
		expect(text).toContain("Reason: provider unavailable");
		expect(text).toContain('Next: Retry action "start"');
		tool.dispose();
	});

	test("formats a start call error with Reason and Next", async () => {
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession(),
		});
		tool.dispose();

		const failed = await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "map it" } }],
		});
		const text = failed.content[0]?.type === "text" ? failed.content[0].text : "";
		expect(failed.isError).toBe(true);
		expect(text).toContain("Reason: Hands closed");
		expect(text).toContain('Next: Retry action "start"');
	});

	test("does not count finished hands against the running limit", async () => {
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession(),
		});
		const tasks = Array.from({ length: MAX_HANDS }, (_, index) => ({
			kind: "scout" as const,
			input: { root: "src", question: `first batch ${index}` },
		}));

		const first = await execute(tool, { action: "start", hands: tasks });
		expect(first.isError).toBe(false);
		await execute(tool, { action: "wait", hand: `Hand ${MAX_HANDS}` });

		const second = await execute(tool, { action: "start", hands: tasks });
		expect(second.isError).toBe(false);
		tool.dispose();
	});

	test("rejects a start that exceeds the running limit", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ gateFirstPrompt: gate }),
		});
		const tasks = Array.from({ length: MAX_HANDS }, (_, index) => ({
			kind: "scout" as const,
			input: { root: "src", question: `running ${index}` },
		}));

		await execute(tool, { action: "start", hands: tasks });
		const rejected = await execute(tool, { action: "start", hands: tasks.slice(0, 1) });
		const text = rejected.content[0]?.type === "text" ? rejected.content[0].text : "";

		expect(rejected.isError).toBe(true);
		expect(text).toContain("Too many running hands");
		release();
		tool.dispose();
	});

	test("finish stops a running hand", async () => {
		let releaseFirst: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ gateFirstPrompt: gate }),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "stop this" } }],
		});
		const finished = await execute(tool, { action: "finish" });

		expect(finished.details.hands[0]?.status).toBe("cancelled");
		expect(finished.details.hands[0]?.error).toBe("Hand stopped");
		releaseFirst();
		tool.dispose();
	});

	test("shows the coordinator note and queues live notes", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool = createHandsTool({
			emit: () => {},
			createSession: async () => createFakeSession({ gateFirstPrompt: gate }),
		});

		const started = await execute(tool, {
			action: "start",
			hands: [
				{
					kind: "scout",
					input: { root: "src", question: "check login" },
					note: "focus on the parser",
				},
			],
		});
		const first = started.details.hands[0];
		const user = first?.transcript.find((item) => item.role === "user");
		expect(user?.role === "user" ? user.text : "").toContain(
			"Coordinator note:\nfocus on the parser",
		);

		const noted = await execute(tool, {
			action: "note",
			hand: "Hand 1",
			message: "also check the logout path",
		});
		expect(noted.content[0]?.type === "text" ? noted.content[0].text : "").toContain(
			"Note queued",
		);

		release();
		const waited = await execute(tool, { action: "wait" });
		expect(waited.details.hands[0]?.result).toContain("Coordinator note");
		tool.dispose();
	});

	test("records hand usage for the parent session", async () => {
		const recorded: Array<{ provider: string; model: string; cost: number }> = [];
		const tool = createHandsTool({
			emit: () => {},
			recordUsage: (provider, model, usage) => {
				recorded.push({ provider, model, cost: usage.cost.total });
			},
			createSession: async () =>
				createFakeSession({
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.01 },
					},
				}),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "count me" } }],
		});
		await execute(tool, { action: "wait" });

		expect(recorded).toEqual([{ provider: "test", model: "test/model", cost: 0.01 }]);
		tool.dispose();
	});

	test("records hand usage while the hand is still running", async () => {
		const recorded: number[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tool = createHandsTool({
			emit: () => {},
			recordUsage: (_provider, _model, usage) => {
				recorded.push(usage.cost.total);
			},
			createSession: async () =>
				createFakeSession({
					gateAfterAssistant: gate,
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.01 },
					},
				}),
		});

		await execute(tool, {
			action: "start",
			hands: [{ kind: "scout", input: { root: "src", question: "count live" } }],
		});
		await vi.waitFor(() => expect(recorded).toEqual([0.01]));

		release();
		await execute(tool, { action: "wait" });
		expect(recorded).toEqual([0.01]);
		tool.dispose();
	});

	test("sanitizes terminal control and binary tool output", () => {
		const call = (id: string) =>
			({
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
				stopReason: "toolUse",
				timestamp: 0,
			}) as unknown as AgentMessage;
		const result = (id: string, text: string) =>
			({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 0,
			}) as unknown as AgentMessage;

		const safe = buildHandTranscript([call("tool-1"), result("tool-1", "ok\x07\x1b[31mred")]);
		const safeItem = safe.find((item) => item.role === "tool");
		if (safeItem?.role !== "tool") throw new Error("missing tool item");
		expect(safeItem.status).toBe("success");
		expect(safeItem.result?.content[0]?.text).toBe("okred");

		const binary = buildHandTranscript([call("tool-2"), result("tool-2", "start\x00\uFFFD...")]);
		const binaryItem = binary.find((item) => item.role === "tool");
		if (binaryItem?.role !== "tool") throw new Error("missing tool item");
		const binaryText = binaryItem.result?.content[0]?.text ?? "";
		expect(binaryText).toContain("start");
		expect(binaryText).not.toContain("\x00");
		expect(binaryText).not.toContain("binary or control data omitted");
	});
});
