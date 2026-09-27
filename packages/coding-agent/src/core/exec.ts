import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

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
			stdio: ["ignore", "pipe", "pipe"],
		});

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
			cleanup();
			resolve({ stdout, stderr, code, killed });
		};

		proc.on("exit", () => {
			exited = true;
		});

		const killProcess = () => {
			if (killed) return;
			killed = true;
			proc.kill("SIGTERM");
			killTimeoutId = setTimeout(() => {
				if (!exited) proc.kill("SIGKILL");
			}, 5000);
			killTimeoutId.unref();
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		waitForChildProcess(proc)
			.then((code) => finish(code ?? 0))
			.catch(() => finish(1));
	});
}
