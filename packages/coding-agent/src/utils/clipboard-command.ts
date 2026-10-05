import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 3000;

const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export type ClipboardCommandOptions = {
	input?: string;
	timeoutMs?: number;
	maxBufferBytes?: number;
};

export function runClipboardCommand(
	command: string,
	args: readonly string[],
	options?: ClipboardCommandOptions,
): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		const hasInput = options?.input !== undefined;
		const child = spawn(command, args, {
			stdio: ["pipe", hasInput ? "ignore" : "pipe", "ignore"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let length = 0;
		let settled = false;
		const finish = (result: Buffer | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const abort = (): void => {
			child.kill("SIGKILL");
			child.stdout?.destroy();
			child.stdin?.destroy();
			finish(undefined);
		};
		const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(abort, timeoutMs);
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			if (settled) return;
			const output = code === 0 ? Buffer.concat(chunks, length) : undefined;
			finish(output);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			length += chunk.length;
			const maxBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
			if (length > maxBytes) {
				abort();
				return;
			}
			chunks.push(chunk);
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(options?.input);
	});
}
