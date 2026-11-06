export const ABORT_MESSAGE = "Operation aborted";

export function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error(ABORT_MESSAGE);
}
