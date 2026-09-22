import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { AgentTool } from "@huranth/gama-agent-core";
import { type ChildProcess, spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { commandExitStatus } from "../exit-code.ts";
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "./truncate.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./ui/bash.ts";

const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

const MAX_TIMEOUT_MS = 2_147_483_647;

const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

const SESSION_ENV_NAMES = [
	"GAMA_SESSION_ID",
	"GAMA_SESSION_FILE",
	"GAMA_PROVIDER",
	"GAMA_MODEL",
	"GAMA_REASONING_LEVEL",
];

export type BashToolInput = Static<typeof bashSchema>;

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface BashToolOptions {
	operations?: BashOperations;
	commandPrefix?: string;
	shellPath?: string;
	exposeSessionEnvironment?: boolean;
	spawnHook?: BashSpawnHook;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
	),
});

const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: [
		"You can inspect GAMA_* environment variables for current model and session details.",
	],
} as const;

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "gama-bash",
};

export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(
	cwd: string,
	options?: BashToolOptions,
): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Timeout must be a positive number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Timeout is too long, the maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = buildSessionEnv(exposeSessionEnvironment ? ctx : undefined);
	const baseContext: BashSpawnContext = { command, cwd, env };

	return spawnHook ? spawnHook(baseContext) : baseContext;
}

function buildSessionEnv(ctx: ExtensionContext | undefined): NodeJS.ProcessEnv {
	const env = { ...getShellEnv() };

	for (const name of SESSION_ENV_NAMES) {
		delete env[name];
	}

	if (!ctx) return env;

	env.GAMA_SESSION_ID = ctx.sessionManager.getSessionId();

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.GAMA_SESSION_FILE = sessionFile;

	const model = ctx.model;
	if (model) {
		env.GAMA_PROVIDER = model.provider;
		env.GAMA_MODEL = model.id;
	}

	if (ctx.thinkingLevel) env.GAMA_REASONING_LEVEL = ctx.thinkingLevel;

	return env;
}

export function createLocalShellOperations(
	shellName: string,
	resolveShellConfig: () => ShellConfig,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const shellConfig = resolveShellConfig();
			await assertDirectory(cwd, shellName);

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(
				shellConfig.shell,
				commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
				{
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);

			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}

			if (child.pid) trackDetachedChildPid(child.pid);

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => killChild(child);

			try {
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						killChild(child);
					}, timeoutMs);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				const exitCode = await waitForExit(child, shellConfig, shellName);

				if (signal?.aborted) {
					throw new Error("aborted");
				}

				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}

				const signalCode = child.signalCode;
				const signalExitCode = signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1;

				return { exitCode: exitCode ?? signalExitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

async function assertDirectory(cwd: string, shellName: string): Promise<void> {
	try {
		await fsAccess(cwd, constants.F_OK);
	} catch {
		throw new Error(
			`Could not run ${shellName} commands, the working directory ${cwd} does not exist`,
		);
	}
}

function killChild(child: ChildProcess): void {
	if (child.pid) killProcessTree(child.pid);
}

async function waitForExit(
	child: ChildProcess,
	shellConfig: ShellConfig,
	shellName: string,
): Promise<number | null> {
	try {
		return await waitForChildProcess(child);
	} catch (error) {
		throw describeSpawnError(error, shellConfig.shell, shellName);
	}
}

function describeSpawnError(error: unknown, shell: string, shellName: string): Error {
	const code = error instanceof Error && "code" in error ? error.code : undefined;

	if (code === "ENOENT") {
		return new Error(`Could not run ${shellName}, the shell ${shell} was not found`);
	}

	if (code === "EACCES" || code === "EPERM") {
		return new Error(`Could not run ${shellName}, permission denied`);
	}

	const reason = error instanceof Error ? error.message : String(error);

	return new Error(`Could not run ${shellName}, ${reason}`);
}

function describeExecError(error: unknown, text: string): unknown {
	if (error instanceof Error && error.message === "aborted") {
		return new Error(withStatus(text, "The command was aborted"));
	}

	if (error instanceof Error && error.message.startsWith("timeout:")) {
		const timeoutSecs = error.message.split(":")[1];
		const unit = timeoutSecs === "1" ? "second" : "seconds";

		return new Error(withStatus(text, `The command timed out after ${timeoutSecs} ${unit}`));
	}

	return error;
}

function withStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

function truncationNotice(
	truncation: TruncationResult,
	fullOutputPath: string | undefined,
	lastLineBytes: number,
): string {
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	const fullOutput = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

	if (truncation.lastLinePartial) {
		const lastLineSize = formatSize(lastLineBytes);

		return (
			`\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} ` +
			`(line is ${lastLineSize})${fullOutput}]`
		);
	}

	if (truncation.truncatedBy === "lines") {
		return `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutput}]`;
	}

	return (
		`\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} ` +
		`(${formatSize(truncation.maxBytes)} limit)${fullOutput}]`
	);
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description:
			`Execute a ${config.shellName} command in the current working directory. ` +
			`Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} ` +
			`lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). ` +
			"If truncated, full output is saved to a temp file. " +
			"Optionally provide a timeout in seconds.",
		promptSnippet: config.promptSnippet,
		promptGuidelines:
			exposeSessionEnvironment && config.promptGuidelines
				? [...config.promptGuidelines]
				: undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (
				snapshot: Awaited<ReturnType<typeof finishOutput>>,
				emptyText = "",
			) => {
				const truncation = snapshot.truncation;
				const text = snapshot.content || emptyText;

				if (!truncation.truncated) {
					return { text, details: undefined };
				}

				const details: BashToolDetails = {
					truncation,
					fullOutputPath: snapshot.fullOutputPath,
				};
				const notice = truncationNotice(
					truncation,
					snapshot.fullOutputPath,
					output.getLastLineBytes(),
				);

				return { text: `${text}${notice}`, details };
			};

			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (error) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					throw describeExecError(error, text);
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(withStatus(outputText, "The command ended without an exit code"));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (exitCode !== 0) {
					return {
						content: [
							{
								type: "text",
								text: withStatus(outputText, commandExitStatus(exitCode)),
							},
						],
						details,
						structuredContent,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: outputText || "No output" }],
					details,
					structuredContent,
				};
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}
