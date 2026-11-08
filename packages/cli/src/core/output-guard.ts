type RawWrite = (chunk: string, callback?: (error?: Error | null) => void) => boolean;

interface StdoutTakeoverState {
	rawStdoutWrite: RawWrite;
	rawStderrWrite: RawWrite;
	originalStdoutWrite: typeof process.stdout.write;
}

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let stdoutTakeoverState: StdoutTakeoverState | undefined;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;

		if (tail === rawStdoutWriteTail) return;
	}
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) return;

	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));

	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) return;

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as RawWrite;
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as RawWrite;
	const originalStdoutWrite = process.stdout.write;

	// Redirect
	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}

		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) return;

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

function getRawStdoutWrite(): RawWrite {
	if (stdoutTakeoverState) return stdoutTakeoverState.rawStdoutWrite;

	return process.stdout.write.bind(process.stdout) as RawWrite;
}

function writeOnce(text: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {
			getRawStdoutWrite()(text, (error) => {
				if (error) reject(error);
				else resolve();
			});
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function isBackpressureError(code: unknown): boolean {
	return code === "ENOBUFS" || code === "EAGAIN" || code === "EWOULDBLOCK";
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await writeOnce(text);
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (!isBackpressureError(code)) throw writeError;

			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}
