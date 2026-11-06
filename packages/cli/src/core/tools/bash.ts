import { constants } from "node:fs";
import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { AgentTool, AgentToolUpdateCallback } from "@huranth/gama-agent-core";
import { type ChildProcess, spawn } from "node:child_process";
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
import type { ExtensionContext, ToolDefinition } from "../ext/types.ts";
import { describeCommandFailure, formatCommandFailure, formatFailure } from "./command-failure.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "./truncate.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./ui/bash.ts";

const MS_PER_SECOND = 1000;

const TENTHS_PER_SECOND = 10;

const MS_PER_TENTH_SECOND = MS_PER_SECOND / TENTHS_PER_SECOND;

const BYTES_PER_KB = 1024;

const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

const DEFAULT_TIMEOUT_SECONDS = 120;

const KILL_FALLBACK_MS = 2_000;

const FALLBACK_EXIT_CODE = 1;

const SIGNAL_EXIT_OFFSET = 128;

const STRUCTURED_OUTPUT_MAX_BYTES = BYTES_PER_MB;

// Internal signals
const ABORTED_MESSAGE = "aborted";

const TIMEOUT_PREFIX = "timeout:";

// Timer limit
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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
		Type.Number({ description: `Timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})` }),
	),
});

const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	error: Type.Optional(Type.String({ description: "Short failure reason" })),
	hint: Type.Optional(Type.String({ description: "Suggested next step" })),
	wall_time_seconds: Type.Number(),
});

export const sessionEnvGuideline =
	"You can inspect GAMA_* environment variables for current model and session details.";

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: [
		sessionEnvGuideline,
		`Set a timeout when a command could hang; it defaults to ` +
			`${DEFAULT_TIMEOUT_SECONDS} seconds when omitted.`,
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
	return createLocalShellOperations(() => getShellConfig(options?.shellPath));
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
	return buildShellTool(createBashToolDefinition(cwd, options));
}

export function buildShellTool(
	definition: ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState>,
): AgentTool<typeof bashSchema> {
	const tool = wrapToolDefinition(definition);

	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});

	return tool;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	const resolved = timeout ?? DEFAULT_TIMEOUT_SECONDS;

	if (!Number.isFinite(resolved) || resolved <= 0) {
		throw new Error("Bad timeout");
	}

	const timeoutMs = resolved * MS_PER_SECOND;

	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error("Timeout high");
	}

	return timeoutMs;
}

function withStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
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

async function assertDirectory(cwd: string): Promise<void> {
	try {
		await fsAccess(cwd, constants.F_OK);

		const stats = await fsStat(cwd);
		if (!stats.isDirectory()) throw new Error("Bad path");
	} catch {
		throw new Error("Cwd missing");
	}
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
	try {
		return await waitForChildProcess(child);
	} catch (error) {
		throw describeSpawnError(error);
	}
}

function describeSpawnError(error: unknown): Error {
	const code = error instanceof Error && "code" in error ? error.code : undefined;

	if (code === "ENOENT") {
		return new Error("Shell missing");
	}

	if (code === "EACCES" || code === "EPERM") {
		return new Error("Permission denied");
	}

	return new Error("Shell failed");
}

const SHORT_FAILURES = new Set([
	"Bad timeout",
	"Timeout high",
	"Cwd missing",
	"Shell missing",
	"Permission denied",
	"Shell failed",
	"Command aborted",
	"Cancelled",
]);

function describeExecError(error: unknown, text: string): unknown {
	if (error instanceof Error && error.message === ABORTED_MESSAGE) {
		const status = formatFailure({
			error: "Command aborted",
			hint: "Run again",
		});

		return new Error(withStatus(text, status));
	}

	if (error instanceof Error && error.message.startsWith(TIMEOUT_PREFIX)) {
		const timeoutSecs = error.message.slice(TIMEOUT_PREFIX.length);
		const status = formatFailure({
			error: `Timed out ${timeoutSecs}s`,
			hint: "Raise timeout",
		});

		return new Error(withStatus(text, status));
	}

	const reason = error instanceof Error ? error.message.trim() : "";
	const label = SHORT_FAILURES.has(reason) ? reason : reason || "Command start failed";
	const status = formatFailure({
		error: label,
		hint: "Check command",
	});

	return new Error(withStatus(text, status));
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

type BashSnapshot = ReturnType<OutputAccumulator["snapshot"]>;

type OutputUpdate = AgentToolUpdateCallback<BashToolDetails | undefined>;

function formatBashOutput(
	snapshot: BashSnapshot,
	lastLineBytes: number,
	emptyText = "",
): { text: string; details: BashToolDetails | undefined } {
	const truncation = snapshot.truncation;
	const text = snapshot.content || emptyText;

	if (!truncation.truncated) return { text, details: undefined };

	const details: BashToolDetails = {
		truncation,
		fullOutputPath: snapshot.fullOutputPath,
	};
	const notice = truncationNotice(truncation, snapshot.fullOutputPath, lastLineBytes);

	return { text: `${text}${notice}`, details };
}

// Update throttle
function createOutputThrottle(output: OutputAccumulator, onUpdate: OutputUpdate | undefined) {
	let timer: NodeJS.Timeout | undefined;
	let dirty = false;
	let lastAt = 0;

	const emit = () => {
		if (!onUpdate || !dirty) return;

		dirty = false;
		lastAt = Date.now();

		const snapshot = output.snapshot({ persistIfTruncated: true });

		onUpdate({
			content: [{ type: "text", text: snapshot.content || "" }],
			details: {
				truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
				fullOutputPath: snapshot.fullOutputPath,
			},
		});
	};

	const clear = () => {
		if (!timer) return;

		clearTimeout(timer);
		timer = undefined;
	};

	const schedule = () => {
		if (!onUpdate) return;

		dirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastAt);

		if (delay <= 0) {
			clear();
			emit();
			return;
		}

		timer ??= setTimeout(() => {
			timer = undefined;
			emit();
		}, delay);
	};

	return { emit, clear, schedule };
}

export function createLocalShellOperations(
	resolveShellConfig: () => ShellConfig,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);

			if (signal?.aborted) throw new Error(ABORTED_MESSAGE);

			const shellConfig = resolveShellConfig();
			await assertDirectory(cwd);

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
			let killFallbackHandle: NodeJS.Timeout | undefined;
			let killRequested = false;

			// Kill tree
			const killChild = () => {
				if (killRequested) return;
				killRequested = true;

				if (child.pid) killProcessTree(child.pid);

				// Fallback kill
				killFallbackHandle = setTimeout(() => {
					killFallbackHandle = undefined;
					if (child.exitCode !== null || child.signalCode !== null) return;

					try {
						child.kill("SIGKILL");
					} catch {}
				}, KILL_FALLBACK_MS);

				killFallbackHandle.unref();
			};

			const onAbort = () => killChild();

			try {
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						killChild();
					}, timeoutMs);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				const exitCode = await waitForExit(child);

				if (signal?.aborted) throw new Error(ABORTED_MESSAGE);

				if (timedOut && timeoutMs !== undefined) {
					throw new Error(`${TIMEOUT_PREFIX}${timeoutMs / MS_PER_SECOND}`);
				}

				const signalCode = child.signalCode;
				const signalExitCode = signalCode
					? SIGNAL_EXIT_OFFSET + (osConstants.signals[signalCode] ?? 0)
					: FALLBACK_EXIT_CODE;

				return { exitCode: exitCode ?? signalExitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (killFallbackHandle) clearTimeout(killFallbackHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
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
			`lines or ${DEFAULT_MAX_BYTES / BYTES_PER_KB}KB (whichever is hit first). ` +
			"If truncated, full output is saved to a temp file. " +
			"Failed commands include a reason and a next step. " +
			"Set a timeout in seconds when a command could hang.",
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
			const throttle = createOutputThrottle(output, onUpdate);
			let acceptingOutput = true;

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;

				output.append(data);
				throttle.schedule();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				throttle.clear();
				throttle.emit();

				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();

				return snapshot;
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
					const { text } = formatBashOutput(snapshot, output.getLastLineBytes(), "");

					throw describeExecError(error, text);
				}

				const snapshot = await finishOutput();
				const lastLineBytes = output.getLastLineBytes();
				const { text: outputText, details } = formatBashOutput(snapshot, lastLineBytes);

				if (exitCode === null) {
					const status = formatFailure({
						error: "No exit",
						hint: "Run again",
					});

					throw new Error(withStatus(outputText, status));
				}

				const elapsedMs = performance.now() - startedAt;
				const wallTimeSeconds = Math.round(elapsedMs / MS_PER_TENTH_SECOND) / TENTHS_PER_SECOND;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const failure = describeCommandFailure(outputText, exitCode, command);

				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					...(failure ? { error: failure.error, hint: failure.hint } : {}),
					wall_time_seconds: wallTimeSeconds,
				};

				if (exitCode !== 0) {
					const status = formatCommandFailure(outputText, exitCode, command);

					return {
						content: [{ type: "text", text: withStatus(outputText, status) }],
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
				throttle.clear();
			}
		},
		...createShellRenderers(config.prompt),
	};
}
