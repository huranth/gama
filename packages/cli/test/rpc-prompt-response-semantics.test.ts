import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner } from "@huranth/gama-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
} from "@huranth/gama-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadExtensionsResult } from "../src/core/ext/index.ts";
import type { SessionRuntime } from "../src/core/session/runtime.ts";
import { RunSession } from "../src/core/session/session.ts";
import { SessionStore } from "../src/core/sessions.ts";
import { SettingsStore } from "../src/core/settings.ts";
import { AuthStorage } from "../src/core/vault.ts";
import { runRpcMode } from "../src/rpc/server.ts";
import {
	createInMemoryModelRegistry,
	getModelRuntime,
	registerTestAnthropicProvider,
	testAnthropicModel,
} from "./model-run-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./test-helpers.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	inputErrorHandler: undefined as ((error: Error) => void) | undefined,
	failingWrites: false,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		if (rpcIo.failingWrites && line.includes('"get_state"')) {
			throw new Error("write broke");
		}
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/term/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn(
		(
			_stream: NodeJS.ReadableStream,
			onLine: (line: string) => void,
			onError: (error: Error) => void,
		) => {
			rpcIo.lineHandler = onLine;
			rpcIo.inputErrorHandler = onError;
			return () => {};
		},
	),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	extensionsResult?: LoadExtensionsResult;
}): Promise<{
	runtimeHost: SessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(
		tmpdir(),
		`gama-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? testAnthropicModel;
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Runner({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage("done"),
					});
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionStore.inMemory();
	const settingsManager = SettingsStore.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	registerTestAnthropicProvider(modelRegistry);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new RunSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader({ extensionsResult: options.extensionsResult }),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as SessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				await session.abort();
			} catch {}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: Parameters<typeof createRuntimeHost>[0]): Promise<{
	lineHandler: (line: string) => void;
	runtimeHost: SessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	rpcIo.inputErrorHandler = undefined;
	rpcIo.failingWrites = false;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, runtimeHost, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.inputErrorHandler = undefined;
		rpcIo.failingWrites = false;
	});

	it("keeps reading lines after one line handler throws", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			rpcIo.failingWrites = true;
			lineHandler(JSON.stringify({ id: "boom", type: "get_state" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({ command: "input", success: false, error: "write broke" }),
				);
			});

			rpcIo.failingWrites = false;
			lineHandler(JSON.stringify({ id: "after", type: "get_state" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({ id: "after", command: "get_state", success: true }),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining("No API key found for fake-provider."),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("responds safely when prompt rejects a non-Error", async () => {
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
		});
		const session = runtimeHost.session as unknown as {
			prompt: (...args: unknown[]) => Promise<unknown>;
		};
		const originalPrompt = session.prompt;
		session.prompt = () => Promise.reject("prompt failed");

		try {
			lineHandler(JSON.stringify({ id: "b2a", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2a");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2a",
					type: "response",
					command: "prompt",
					success: false,
					error: "prompt failed",
				});
			});
		} finally {
			session.prompt = originalPrompt;
			await cleanup();
		}
	});

	it("emits one started response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
					data: { disposition: "started" },
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("reports extension commands and intercepted input as handled without starting a run", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(gama) => {
					gama.registerCommand("handled", { handler: async () => {} });
					gama.on("input", (event) => {
						if (event.text === "handled input") return { action: "handled" };
					});
				},
			]),
		});

		try {
			for (const [id, message] of [
				["command", "/handled"],
				["input", "handled input"],
			]) {
				lineHandler(JSON.stringify({ id, type: "prompt", message }));
				await vi.waitFor(() => {
					expect(getPromptResponses(rpcIo.outputLines, id)).toEqual([
						{
							id,
							type: "response",
							command: "prompt",
							success: true,
							data: { disposition: "handled" },
						},
					]);
				});
			}
			expect(
				parseOutputLines(rpcIo.outputLines).filter((line) => line.type === "agent_start"),
			).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
					data: { disposition: "queued" },
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it.each(["steer", "follow_up"] as const)(
		"reports %s as handled even when an extension queues another message",
		async (type) => {
			const { lineHandler, cleanup } = await startRpcMode({
				withAuth: true,
				responseDelayMs: 500,
				extensionsResult: await createTestExtensionsResult([
					(gama) => {
						gama.on("input", (event) => {
							if (event.text === "A" && event.source === "rpc") {
								gama.sendUserMessage("B", {
									deliverAs: type === "steer" ? "steer" : "followUp",
								});
								return { action: "handled" };
							}
						});
					},
				]),
			});

			try {
				lineHandler(JSON.stringify({ id: "start", type: "prompt", message: "Start" }));
				await vi.waitFor(() =>
					expect(getPromptResponses(rpcIo.outputLines, "start")).toHaveLength(1),
				);

				lineHandler(JSON.stringify({ id: "A", type, message: "A" }));
				await vi.waitFor(() => {
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						id: "A",
						type: "response",
						command: type,
						success: true,
						data: { disposition: "handled" },
					});
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						type: "queue_update",
						steering: type === "steer" ? ["B"] : [],
						followUp: type === "follow_up" ? ["B"] : [],
					});
				});
				await vi.waitFor(() => {
					expect(
						parseOutputLines(rpcIo.outputLines).filter(
							(line) => line.type === "response" && line.id === "A",
						),
					).toHaveLength(1);
				});
			} finally {
				await cleanup();
			}
		},
	);

	it.each(["steer", "follow_up"] as const)(
		"reports %s as queued after input transformation",
		async (type) => {
			const { lineHandler, cleanup } = await startRpcMode({
				withAuth: false,
				responseDelayMs: 0,
				extensionsResult: await createTestExtensionsResult([
					(gama) => {
						gama.on("input", (event) => {
							if (event.text === "A") return { action: "transform", text: "B" };
						});
					},
				]),
			});

			try {
				lineHandler(JSON.stringify({ id: "A", type, message: "A" }));
				await vi.waitFor(() => {
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						id: "A",
						type: "response",
						command: type,
						success: true,
						data: { disposition: "queued" },
					});
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						type: "queue_update",
						steering: type === "steer" ? ["B"] : [],
						followUp: type === "follow_up" ? ["B"] : [],
					});
				});
			} finally {
				await cleanup();
			}
		},
	);

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toMatchObject([
					{ data: { disposition: "queued" } },
				]);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: ["Change direction"],
						followUp: ["Summarize when finished"],
					},
				});
			});

			await sleep(600);
			expect(
				parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start"),
			).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("binds extensions once when a session command replaces the session", async () => {
		const sessionStarts: string[] = [];
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(gama) => {
					gama.on("session_start", (event) => {
						sessionStarts.push(event.reason);
					});
				},
			]),
		});

		try {
			await vi.waitFor(() => expect(sessionStarts).toHaveLength(1));
			// Rebind
			const rebind = vi.mocked(runtimeHost.setRebindSession).mock.calls[0]![0]!;
			vi.mocked(runtimeHost.newSession).mockImplementation((async () => {
				await rebind(runtimeHost.session);
				return { cancelled: false };
			}) as never);

			lineHandler(JSON.stringify({ id: "ns", type: "new_session" }));
			await vi.waitFor(() =>
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "ns",
					type: "response",
					command: "new_session",
					success: true,
					data: { cancelled: false },
				}),
			);

			expect(sessionStarts).toHaveLength(2);
		} finally {
			await cleanup();
		}
	});

	it("waits for an in-flight prompt to settle before shutting down on stdin EOF", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 150,
		});

		try {
			lineHandler(JSON.stringify({ id: "eof", type: "prompt", message: "Hello" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).some((l) => l.type === "agent_start")).toBe(
					true,
				);
			});

			process.stdin.emit("end");
			await sleep(50);
			expect(runtimeHost.dispose).not.toHaveBeenCalled();

			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			expect(parseOutputLines(rpcIo.outputLines).some((l) => l.type === "agent_settled")).toBe(
				true,
			);
			expect(exit).toHaveBeenCalled();
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("cancels pending extension dialogs on stdin EOF so shutdown completes", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(gama) => {
					gama.on("input", async (_event, ctx) => {
						await ctx.ui.confirm("Proceed?", "blocked on the client");
					});
				},
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "dlg", type: "prompt", message: "Hello" }));
			await vi.waitFor(() => {
				expect(
					parseOutputLines(rpcIo.outputLines).some((l) => l.type === "extension_ui_request"),
				).toBe(true);
			});

			process.stdin.emit("end");

			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			expect(exit).toHaveBeenCalled();
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("rejects pending extension dialogs when the input stream fails", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const rejections: string[] = [];
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(gama) => {
					gama.on("input", async (_event, ctx) => {
						await ctx.ui
							.confirm("Proceed?", "blocked on the client")
							.catch((error: unknown) => {
								rejections.push(error instanceof Error ? error.message : String(error));
							});
					});
				},
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "dlg", type: "prompt", message: "Hello" }));
			await vi.waitFor(() => {
				expect(
					parseOutputLines(rpcIo.outputLines).some((l) => l.type === "extension_ui_request"),
				).toBe(true);
			});

			rpcIo.inputErrorHandler?.(new Error("stdin broke"));

			await vi.waitFor(() => expect(rejections).toEqual(["Input stream failed"]));
			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			await cleanup();
			exit.mockRestore();
		}
	});

	it("stops waiting for hung in-flight work after the EOF drain cap", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const { lineHandler, runtimeHost, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(gama) => {
					gama.on("input", () => new Promise<void>(() => {}));
				},
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "hung", type: "prompt", message: "Hello" }));
			await sleep(20);

			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			process.stdin.emit("end");
			await vi.advanceTimersByTimeAsync(29_000);
			expect(runtimeHost.dispose).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2_000);
			vi.useRealTimers();

			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
		} finally {
			vi.useRealTimers();
			exit.mockRestore();
			await cleanup();
		}
	});
});
