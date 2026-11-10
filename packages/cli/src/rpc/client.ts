import { type ChildProcess, spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { AgentMessage, ThinkingLevel } from "@huranth/gama-agent-core";
import type { ImageContent } from "@huranth/gama-ai";
import type { BashResult } from "../core/bash-executor.ts";
import type { CompactionResult } from "../core/comp/index.ts";
import type {
	PromptDisposition,
	QueuedInputDisposition,
	SessionStats,
} from "../core/session/session.ts";
import type { SessionEntry, SessionTreeNode } from "../core/sessions.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./types.ts";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

const RESPONSE_TIMEOUT_MS = 30_000;

const IDLE_TIMEOUT_MS = 60_000;

const KILL_TIMEOUT_MS = 1_000;

const START_SETTLE_MS = 100;

// Long commands
const LONG_RUNNING_COMMANDS: ReadonlySet<string> = new Set([
	"prompt",
	"bash",
	"compact",
	"fork",
	"clone",
	"new_session",
	"switch_session",
	"export_html",
]);

export interface RpcClientOptions {
	cliPath?: string;
	cwd?: string;
	env?: Record<string, string>;
	provider?: string;
	model?: string;
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: JsonAgentSessionEvent) => void;

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private pendingRequests: Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	> = new Map();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private writeQueue: Promise<void> = Promise.resolve();
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client started");
		}

		this.exitError = null;
		this.writeQueue = Promise.resolve();

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent failed: ${error.message}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError = this.exitError ?? new Error(`Agent stdin failed: ${error.message}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		await new Promise((resolve) => setTimeout(resolve, START_SETTLE_MS));

		if (this.process.exitCode !== null || this.exitError) {
			const error =
				this.exitError ??
				this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, KILL_TIMEOUT_MS);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.writeQueue = Promise.resolve();
		this.eventListeners = [];
		this.rejectPendingRequests(new Error("Client stopped"));
	}

	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	getStderr(): string {
		return this.stderr;
	}

	async prompt(
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
	): Promise<PromptDisposition> {
		const response = await this.send({ type: "prompt", message, images, streamingBehavior });
		return this.getData<{ disposition: PromptDisposition }>(response).disposition;
	}

	async steer(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.send({ type: "steer", message, images });
		return this.getData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	async followUp(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.send({ type: "follow_up", message, images });
		return this.getData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const response = await this.send({ type: "clear_queue" });
		return this.getData(response);
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	async respondToExtensionUI(response: RpcExtensionUIResponse): Promise<void> {
		const stdin = this.process?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error("Client not started");
		}
		await this.writeLine(stdin, serializeJsonLine(response));
	}

	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response)
			.messages;
	}

	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	waitForIdle(timeout = IDLE_TIMEOUT_MS): Promise<void> {
		return this.waitForSettled(timeout, "Idle timeout").then(() => undefined);
	}

	collectEvents(
		timeout = IDLE_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<JsonAgentSessionEvent[]> {
		return this.waitForSettled(timeout, "Event timeout", signal);
	}

	async promptAndWait(
		message: string,
		images?: ImageContent[],
		timeout = IDLE_TIMEOUT_MS,
	): Promise<JsonAgentSessionEvent[]> {
		const collector = new AbortController();
		const eventsPromise = this.collectEvents(timeout, collector.signal);
		try {
			await this.prompt(message, images);
		} catch (error) {
			collector.abort();
			eventsPromise.catch(() => {});
			throw error;
		}
		return eventsPromise;
	}

	private waitForSettled(
		timeout: number,
		timeoutMessage: string,
		signal?: AbortSignal,
	): Promise<JsonAgentSessionEvent[]> {
		return new Promise((resolve, reject) => {
			const self = this;
			const events: JsonAgentSessionEvent[] = [];
			const child = this.process;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribe = () => {};
			let settled = false;

			function cleanup(): void {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				unsubscribe();
				child?.removeListener("exit", onExit);
				child?.removeListener("error", onError);
				signal?.removeEventListener("abort", onAbort);
			}

			function fail(error: Error): void {
				cleanup();
				reject(error);
			}

			function onExit(code: number | null, exitSignal: NodeJS.Signals | null): void {
				fail(self.exitError ?? self.createProcessExitError(code, exitSignal));
			}

			function onError(error: Error): void {
				fail(self.exitError ?? new Error(`Agent failed: ${error.message}`));
			}

			function onAbort(): void {
				fail(new Error("Collector cancelled"));
			}

			function onEvent(event: JsonAgentSessionEvent): void {
				if (settled) return;
				events.push(event);
				if (event.type !== "agent_settled") return;

				cleanup();
				resolve(events);
			}

			timer = setTimeout(() => {
				fail(new Error(`${timeoutMessage}: ${self.stderr}`));
			}, timeout);
			unsubscribe = this.onEvent(onEvent);
			child?.once("exit", onExit);
			child?.once("error", onError);
			signal?.addEventListener("abort", onAbort, { once: true });

			if (signal?.aborted) {
				onAbort();
				return;
			}
			if (this.exitError) {
				fail(this.exitError);
				return;
			}
			if (child && child.exitCode !== null) {
				onExit(child.exitCode, child.signalCode);
			}
		});
	}

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);
			const pending = data.id ? this.pendingRequests.get(data.id) : undefined;

			if (data.type === "response") {
				if (!pending) {
					if (!data.id && data.success === false && typeof data.error === "string") {
						this.rejectPendingRequests(new Error(data.error));
					}
					return;
				}
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			for (const listener of [...this.eventListeners]) {
				listener(data as JsonAgentSessionEvent);
			}
		} catch {
			// Unparsable
		}
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		const reason = signal === null ? `code ${code}` : `signal ${signal}`;
		return new Error(`Agent exited: ${reason}`);
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error("Agent stdin closed");
			this.exitError = error;
			throw error;
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = LONG_RUNNING_COMMANDS.has(command.type)
				? undefined
				: setTimeout(() => {
						this.pendingRequests.delete(id);
						reject(new Error(`Request timeout: ${command.type}`));
					}, RESPONSE_TIMEOUT_MS);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			void this.writeLine(stdin, serializeJsonLine(fullCommand)).catch((error: unknown) => {
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			});
		});
	}

	private writeLine(stdin: Writable, line: string): Promise<void> {
		const write = this.writeQueue.then(
			() =>
				new Promise<void>((resolve, reject) => {
					stdin.write(line, (error) => {
						if (error) reject(error);
						else resolve();
					});
				}),
		);

		this.writeQueue = write.catch(() => {});
		return write;
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
