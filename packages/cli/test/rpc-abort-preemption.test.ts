import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionRuntime } from "../src/core/session/runtime.ts";
import { runRpcMode } from "../src/rpc/server.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/term/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn(
		(_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
			rpcIo.lineHandler = onLine;
			return () => {
				rpcIo.lineHandler = undefined;
			};
		},
	),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] =
		process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(
			signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]]),
		),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): SessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as SessionRuntime;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return {
		promise,
		resolve: () => resolve?.(),
	};
}

describe("RPC abort preemption", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("abort_bash responds while a bash command is still running", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const bashStarted = deferred();
		const bashRelease = deferred();

		const executeBash = vi.spyOn(harness.session, "executeBash").mockImplementation(async () => {
			bashStarted.resolve();
			await bashRelease.promise;
			return { output: "", exitCode: 0, cancelled: true, truncated: false };
		});
		const abortBash = vi.spyOn(harness.session, "abortBash").mockImplementation(() => {});

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "bash", type: "bash", command: "sleep" }));
			await bashStarted.promise;

			rpcIo.lineHandler?.(JSON.stringify({ id: "stop", type: "abort_bash" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "stop",
					type: "response",
					command: "abort_bash",
					success: true,
				});
			});
			expect(parseOutputLines().some((line) => line.id === "bash")).toBe(false);

			bashRelease.resolve();
			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual(
					expect.objectContaining({ id: "bash", command: "bash", success: true }),
				);
			});
		} finally {
			executeBash.mockRestore();
			abortBash.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("abort responds while a compact is still running", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const compactStarted = deferred();
		const compactRelease = deferred();

		const compact = vi.spyOn(harness.session, "compact").mockImplementation(async () => {
			compactStarted.resolve();
			await compactRelease.promise;
			return undefined as never;
		});
		const abort = vi.spyOn(harness.session, "abort").mockImplementation(async () => {});

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "compact", type: "compact" }));
			await compactStarted.promise;

			rpcIo.lineHandler?.(JSON.stringify({ id: "stop", type: "abort" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "stop",
					type: "response",
					command: "abort",
					success: true,
				});
			});
			expect(parseOutputLines().some((line) => line.id === "compact")).toBe(false);

			compactRelease.resolve();
			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual(
					expect.objectContaining({ id: "compact", command: "compact", success: true }),
				);
			});
		} finally {
			compact.mockRestore();
			abort.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
