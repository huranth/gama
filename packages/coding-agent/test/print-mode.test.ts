import { spawn } from "node:child_process";
import type { AssistantMessage, ImageContent } from "@huranth/gama-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheSnapshot, SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { trackDetachedChildPid } from "../src/utils/shell.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	cacheSnapshot: () => CacheSnapshot;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function emptyCacheSnapshot(): CacheSnapshot {
	return {
		rates: [],
		latest: 0,
		totals: {
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			prompt: 0,
			hit: 0,
			spent: 0,
			uncached: 0,
			saved: 0,
		},
		windowMs: undefined,
		leftMs: 0,
		nextWarm: undefined,
		nextCold: undefined,
		model: undefined,
		warmTurns: 0,
		coldTurns: 0,
		warmRatio: 0,
		unreported: 0,
		lookbackPositions: undefined,
		warmSpent: 0,
		warmRequests: 0,
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		cacheSnapshot: () => emptyCacheSnapshot(),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(
			runtimeHost as unknown as Parameters<typeof runPrintMode>[0],
			{
				mode: "text",
				initialMessage: "Say done",
				initialImages: images,
			},
		);

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({
			type: "session_shutdown",
			reason: "quit",
		});
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(
			runtimeHost as unknown as Parameters<typeof runPrintMode>[0],
			{
				mode: "json",
				messages: ["hello"],
			},
		);

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({
			type: "session_shutdown",
			reason: "quit",
		});
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(
			runtimeHost as unknown as Parameters<typeof runPrintMode>[0],
			{
				mode: "text",
			},
		);

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({
			type: "session_shutdown",
			reason: "quit",
		});
	});

	it("kills tracked detached children and exits 130 on SIGINT", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		runtimeHost.session.prompt.mockImplementation(() => new Promise(() => {}));
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		const pid = child.pid as number;
		trackDetachedChildPid(pid);
		const exited = new Promise<number>((resolve) => {
			vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				resolve(code ?? 0);
			}) as never);
		});
		const childGone = new Promise<void>((resolve) => child.once("exit", () => resolve()));

		void runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "hang",
		});
		await vi.waitFor(() => expect(runtimeHost.session.prompt).toHaveBeenCalled());
		process.emit("SIGINT");

		expect(await exited).toBe(130);
		await childGone;
		expect(runtimeHost.dispose).toHaveBeenCalled();
	});
});
