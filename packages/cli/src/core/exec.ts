import { type ChildProcess, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree } from "../utils/shell.ts";

const KILL_GRACE_MS = 5000;

const SIGNAL_EXIT_BASE = 128;

export interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

// Signal code
function signalExitCode(signal: NodeJS.Signals | null): number {
	return signal ? SIGNAL_EXIT_BASE + (osConstants.signals[signal] ?? 0) : 1;
}

function killTree(proc: ChildProcess): void {
	if (process.platform === "win32") {
		if (proc.pid) killProcessTree(proc.pid);
		return;
	}

	if (proc.pid) {
		try {
			process.kill(-proc.pid, "SIGTERM");
			return;
		} catch {
			// Group gone.
		}
	}
	proc.kill("SIGTERM");
}

function hardKill(proc: ChildProcess, hasExited: boolean): void {
	if (hasExited) return;

	if (process.platform === "win32") {
		if (proc.pid) killProcessTree(proc.pid);
		proc.kill("SIGKILL");
		return;
	}

	if (proc.pid) {
		try {
			process.kill(-proc.pid, "SIGKILL");
			return;
		} catch {
			// Group gone.
		}
	}
	proc.kill("SIGKILL");
}

export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			// Kill group.
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let stdout = "";
		let stderr = "";

		let killed = false;
		let exited = false;

		let timeoutId: NodeJS.Timeout | undefined;
		let killTimeoutId: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (killTimeoutId) clearTimeout(killTimeoutId);
			options?.signal?.removeEventListener("abort", killProcess);
		};

		const finish = (code: number) => {
			stdout += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			cleanup();
			resolve({ stdout, stderr, code, killed });
		};

		const killProcess = () => {
			if (killed) return;
			killed = true;

			killTree(proc);

			killTimeoutId = setTimeout(() => {
				hardKill(proc, exited);
			}, KILL_GRACE_MS);
			killTimeoutId.unref();
		};

		proc.on("exit", () => {
			exited = true;
		});

		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(killProcess, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += stdoutDecoder.write(data);
		});

		proc.stderr?.on("data", (data) => {
			stderr += stderrDecoder.write(data);
		});

		waitForChildProcess(proc)
			.then((code) => finish(code ?? signalExitCode(proc.signalCode)))
			.catch(() => finish(1));
	});
}
