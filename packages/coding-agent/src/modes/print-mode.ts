import type { ImageContent } from "@huranth/gama-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { formatMoney, formatPercent } from "../core/cache/view.ts";
import {
	flushRawStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

export interface PrintModeOptions {
	mode: "text" | "json";
	messages?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
}

export async function runPrintMode(
	runtimeHost: AgentSessionRuntime,
	options: PrintModeOptions,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposePromise: Promise<void> | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = () => {
		if (disposePromise) return disposePromise;

		unsubscribe?.();
		unsubscribeBackpressure?.();
		disposePromise = runtimeHost.dispose();
		return disposePromise;
	};

	const registerSignalHandlers = () => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
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
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
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
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		const state = session.state;
		const lastMessage = state.messages[state.messages.length - 1];
		if (lastMessage?.role === "assistant") {
			const failed = lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted";

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
