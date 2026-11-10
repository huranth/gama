import type { ImageContent } from "@huranth/gama-ai";
import { formatMoney, formatPercent } from "./core/cache/view.ts";
import {
	flushRawStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "./core/output-guard.ts";
import type { SessionRuntime } from "./core/session/runtime.ts";
import { toJsonEvent } from "./json-event.ts";
import { disposeWithTimeout } from "./utils/dispose.ts";
import { killTrackedDetachedChildren } from "./utils/shell.ts";

function exitCodeForSignal(signal: NodeJS.Signals): number {
	if (signal === "SIGHUP") return 129;
	if (signal === "SIGINT") return 130;

	return 143;
}

export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
}

export async function runPrintMode(
	runtimeHost: SessionRuntime,
	options: PrintModeOptions,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let failureMessage: string | undefined;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposePromise: Promise<boolean> | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const rememberFailure = () => {
		const last = session.state.messages[session.state.messages.length - 1];
		if (last?.role !== "assistant") return;
		if (last.stopReason !== "error" && last.stopReason !== "aborted") return;
		failureMessage ??= last.errorMessage || `Request ${last.stopReason}`;
	};

	const disposeRuntime = () => {
		if (disposePromise) return disposePromise;

		unsubscribe?.();
		unsubscribeBackpressure?.();
		disposePromise = disposeWithTimeout(() => runtimeHost.dispose());
		return disposePromise;
	};

	async function exitOnSignal(code: number): Promise<never> {
		try {
			await disposeRuntime();
			await flushRawStdout();
		} finally {
			process.exit(code);
		}
	}

	const registerSignalHandlers = () => {
		const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void exitOnSignal(exitCodeForSignal(signal));
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	const rebindSession = async () => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (error) => {
				console.error(`Extension error: ${error.extensionPath}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		if (mode === "json") {
			unsubscribeBackpressure = session.agent.subscribe(async () => {
				await waitForRawStdoutBackpressure();
			});
		} else {
			unsubscribeBackpressure = undefined;
		}
	};

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
			rememberFailure();
		}

		for (const message of messages) {
			await session.prompt(message);
			rememberFailure();
		}

		if (failureMessage) {
			if (mode === "text") console.error(failureMessage);
			exitCode = 1;
		} else {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];
			if (lastMessage?.role === "assistant") {
				const failed =
					lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted";

				if (failed) {
					if (mode === "text") {
						console.error(lastMessage.errorMessage || `Request ${lastMessage.stopReason}`);
					}
					exitCode = 1;
				} else if (mode === "text") {
					for (const content of lastMessage.content) {
						if (content.type === "text") writeRawStdout(`${content.text}\n`);
					}
				}
			}
		}

		if (mode === "text") {
			const cache = session.cacheSnapshot();
			if (cache.rates.length > 0) {
				const saved = cache.totals.saved;
				const suffix = saved > 0 ? `, saved ${formatMoney(saved)}` : "";
				console.error(`cache ${formatPercent(cache.latest)}${suffix}`);
			}
		}

		return exitCode;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
