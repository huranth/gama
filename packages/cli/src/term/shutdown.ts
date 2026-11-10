import * as fs from "node:fs";
import { AltScreen } from "@huranth/gama-tui";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import type { SessionStore } from "../core/sessions.ts";
import { disposeWithTimeout } from "../utils/dispose.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import type { TermApp } from "./app.ts";

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

export function formatCrashExtensionHint(
	extensionMatches: readonly string[] | undefined,
): string | undefined {
	const matches = Array.isArray(extensionMatches)
		? extensionMatches.filter(
				(match): match is string => typeof match === "string" && match.length > 0,
			)
		: [];
	if (matches.length === 0) return undefined;
	const quoted = matches.map((match) => `\`${match}\``);
	const labels =
		quoted.length === 1
			? quoted[0]
			: quoted.length === 2
				? quoted.join(" and ")
				: `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
	const noun = matches.length === 1 ? "extension" : "extensions";
	const pronoun = matches.length === 1 ? "it" : "them";
	return (
		`A stack frame came from loaded ${noun} ${labels}, which may be involved. ` +
		`Try disabling ${pronoun} with \`${APP_NAME} config\`, ` +
		`or run \`${APP_NAME} -ne\` to confirm.`
	);
}

export function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const EXIT_FLUSH_MS = 150;

const SHUTDOWN_OUTPUT_FLUSH_MS = 200;

const SHUTDOWN_DRAIN_MS = 1000;

function exitCodeForSignal(signal: NodeJS.Signals | undefined): number {
	if (signal === "SIGHUP") return 129;
	if (signal === "SIGINT") return 130;

	return 143;
}

async function waitForExitFlush(delayMs = EXIT_FLUSH_MS): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function writeExitReset(): void {
	const sequence = "\x1b[0m\x1b[?1000l\x1b[?1006l\x1b[?25h";
	try {
		fs.writeSync(1, sequence);
	} catch {
		try {
			process.stdout.write(sequence);
		} catch {}
	}
}

async function flushShutdownOutput(timeoutMs = SHUTDOWN_OUTPUT_FLUSH_MS): Promise<void> {
	if (process.stdout.writableLength === 0) return;
	await new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		try {
			process.stdout.write("", () => {
				clearTimeout(timer);
				finish();
			});
		} catch {
			clearTimeout(timer);
			finish();
		}
	});
}

export function formatResumeCommand(sessionManager: SessionStore): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!sessionManager.isPersisted()) return undefined;

	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !fs.existsSync(sessionFile)) return undefined;

	const args = [APP_NAME];
	if (!sessionManager.usesDefaultSessionDir()) {
		args.push("--session-dir", quoteIfNeeded(sessionManager.getSessionDir()));
	}
	args.push("--session", sessionManager.getSessionId());
	return args.join(" ");
}

export function queueCompactionMessage(
	mode: TermApp,
	text: string,
	delivery: "steer" | "followUp",
): void {
	mode.compactionQueuedMessages.push({ text, mode: delivery });
	mode.editor.addToHistory?.(text);
	mode.editor.setText("");
	mode.updatePendingMessagesDisplay();
	mode.showStatus("Message queued");
}

export function isExtensionCommand(mode: TermApp, text: string): boolean {
	if (!text.startsWith("/")) return false;

	const extensionRunner = mode.session.extensionRunner;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	return !!extensionRunner.getCommand(commandName);
}

export async function flushCompactionQueue(
	mode: TermApp,
	options?: { willRetry?: boolean },
): Promise<void> {
	if (mode.compactionQueuedMessages.length === 0) {
		return;
	}

	const queuedMessages = [...mode.compactionQueuedMessages];
	mode.compactionQueuedMessages = [];
	mode.updatePendingMessagesDisplay();

	const restoreQueue = (error: unknown) => {
		mode.session.clearQueue();
		mode.compactionQueuedMessages = queuedMessages;
		mode.updatePendingMessagesDisplay();
		mode.showError(`Send failed: ${error instanceof Error ? error.message : String(error)}`);
	};

	try {
		if (options?.willRetry) {
			for (const message of queuedMessages) {
				if (mode.isExtensionCommand(message.text)) {
					await mode.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await mode.session.followUp(message.text);
				} else {
					await mode.session.steer(message.text);
				}
			}
			mode.updatePendingMessagesDisplay();
			return;
		}

		const firstPromptIndex = queuedMessages.findIndex(
			(message) => !mode.isExtensionCommand(message.text),
		);
		if (firstPromptIndex === -1) {
			for (const message of queuedMessages) {
				await mode.session.prompt(message.text);
			}
			return;
		}

		const preCommands = queuedMessages.slice(0, firstPromptIndex);
		const firstPrompt = queuedMessages[firstPromptIndex];
		const rest = queuedMessages.slice(firstPromptIndex + 1);

		for (const message of preCommands) {
			await mode.session.prompt(message.text);
		}

		const promptPromise = mode.session
			.prompt(firstPrompt.text, { streamingBehavior: firstPrompt.mode })
			.catch((error) => {
				restoreQueue(error);
			});

		for (const message of rest) {
			if (mode.isExtensionCommand(message.text)) {
				await mode.session.prompt(message.text);
			} else if (message.mode === "followUp") {
				await mode.session.followUp(message.text);
			} else {
				await mode.session.steer(message.text);
			}
		}
		mode.updatePendingMessagesDisplay();
		void promptPromise;
	} catch (error) {
		restoreQueue(error);
	}
}

export function flushPendingBashComponents(mode: TermApp): void {
	for (const component of mode.pendingBashComponents) {
		mode.pendingMessagesContainer.removeChild(component);
		mode.chatContainer.addChild(component);
	}
	mode.pendingBashComponents = [];
}

export function handleCtrlC(mode: TermApp): void {
	if (mode.isShuttingDown) return;
	if (mode.ui instanceof AltScreen && mode.ui.hasActiveSelection()) {
		void mode.ui.copyActiveSelectionToClipboard();
		mode.ui.clearActiveSelection();
		mode.ui.requestRender();
		mode.lastSigintTime = Date.now();
		return;
	}

	const now = Date.now();
	if (now - mode.lastSigintTime < 500) {
		void mode.shutdown({ fromSignal: true, signal: "SIGINT" });
	} else {
		mode.clearEditor();
		mode.lastSigintTime = now;
	}
}

export function handleCtrlD(mode: TermApp): void {
	void mode.shutdown();
}

export function handleCtrlZ(mode: TermApp): void {
	if (process.platform === "win32") {
		mode.showStatus("Suspend unsupported");
		return;
	}

	const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

	const ignoreSigint = () => {};
	const onSigcont = () => {
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		mode.ui.start();
		mode.ui.requestRender(true);
	};
	process.on("SIGINT", ignoreSigint);
	process.once("SIGCONT", onSigcont);

	try {
		mode.ui.stop();

		process.kill(0, "SIGTSTP");
	} catch (error) {
		clearInterval(suspendKeepAlive);
		process.removeListener("SIGINT", ignoreSigint);
		process.removeListener("SIGCONT", onSigcont);
		throw error;
	}
}

export function registerSignalHandlers(mode: TermApp): void {
	mode.unregisterSignalHandlers();

	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}

	for (const signal of signals) {
		const handler = () => {
			killTrackedDetachedChildren();
			void mode.shutdown({ fromSignal: true, signal });
		};
		process.prependListener(signal, handler);
		mode.signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	// Ctrl+C
	const sigintHandler = () => {
		mode.handleCtrlC();
	};
	process.prependListener("SIGINT", sigintHandler);
	mode.signalCleanupHandlers.push(() => process.off("SIGINT", sigintHandler));

	// Exit fallback
	const exitHandler = () => {
		if (mode.renderer.mode === "fullscreen") return;
		try {
			mode.renderer.stop({ clearScreen: true });
		} catch {}
	};
	process.prependListener("exit", exitHandler);
	mode.signalCleanupHandlers.push(() => process.off("exit", exitHandler));

	const rejectionHandler = (reason: unknown) => {
		console.error("Unhandled rejection:", reason);
	};
	process.prependListener("unhandledRejection", rejectionHandler);
	mode.signalCleanupHandlers.push(() => process.off("unhandledRejection", rejectionHandler));

	const terminalErrorHandler = (error: Error) => {
		if (isDeadTerminalError(error)) {
			mode.emergencyTerminalExit();
		}

		throw error;
	};
	process.stdout.on("error", terminalErrorHandler);
	process.stderr.on("error", terminalErrorHandler);
	mode.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
	mode.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

	const uncaughtExceptionHandler = (error: Error) => mode.uncaughtCrash(error);
	process.prependListener("uncaughtException", uncaughtExceptionHandler);
	mode.signalCleanupHandlers.push(() =>
		process.off("uncaughtException", uncaughtExceptionHandler),
	);
}

export function unregisterSignalHandlers(mode: TermApp): void {
	for (const cleanup of mode.signalCleanupHandlers) {
		cleanup();
	}
	mode.signalCleanupHandlers = [];
}

export async function shutdown(
	mode: TermApp,
	options?: { fromSignal?: boolean; signal?: NodeJS.Signals },
): Promise<void> {
	if (mode.isShuttingDown) return;
	mode.isShuttingDown = true;

	// Absorb SIGINT
	process.prependListener("SIGINT", () => {});

	if (options?.fromSignal) {
		await disposeWithTimeout(() => mode.runtimeHost.dispose());
		mode.themeController.disableAutoSync();
		await mode.ui.terminal.drainInput(SHUTDOWN_DRAIN_MS);
		await flushShutdownOutput();
		mode.stop("resume-hint");
		await flushShutdownOutput();
		writeExitReset();
		await waitForExitFlush();
		process.exit(exitCodeForSignal(options.signal));
	}

	mode.themeController.disableAutoSync();
	await mode.ui.terminal.drainInput(SHUTDOWN_DRAIN_MS);
	await flushShutdownOutput();

	mode.stop("resume-hint");
	await flushShutdownOutput();
	await disposeWithTimeout(() => mode.runtimeHost.dispose());

	await flushShutdownOutput();
	await waitForExitFlush();

	// Terminal reset
	writeExitReset();

	try {
		mode.sessionManager.persistHeader();
	} catch {}

	const resumeCommand = formatResumeCommand(mode.sessionManager);
	if (resumeCommand) {
		// Bottom row
		process.stdout.write("\x1b[0m\r\n");
		process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		await flushShutdownOutput();
	}

	await waitForExitFlush(60);
	process.exit(0);
}

export function emergencyTerminalExit(mode: TermApp): never {
	mode.isShuttingDown = true;
	mode.unregisterSignalHandlers();
	killTrackedDetachedChildren();
	process.exit(129);
}

export function uncaughtCrash(mode: TermApp, error: Error): never {
	if (mode.isShuttingDown) {
		process.exit(1);
	}
	mode.isShuttingDown = true;
	try {
		mode.unregisterSignalHandlers();
	} catch {}

	try {
		killTrackedDetachedChildren();
	} catch {}

	try {
		mode.ui.stop();
	} catch {}
	console.error("Uncaught exception");
	console.error(error);
	const extensionHint = mode.getCrashExtensionHint(error);
	if (extensionHint) console.error(`\n${extensionHint}`);

	mode.recordCrash("uncaught_exception", error);
	process.exit(1);
}

export async function checkShutdownRequested(mode: TermApp): Promise<void> {
	if (!mode.shutdownRequested) return;
	await mode.shutdown();
}
