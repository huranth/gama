export type SessionCloseHook = (sessionId?: string) => void;

const closeHooks = new Set<SessionCloseHook>();

// Register cleanup
export function onSessionClose(hook: SessionCloseHook): () => void {
	closeHooks.add(hook);
	return () => {
		closeHooks.delete(hook);
	};
}

// Run cleanups
export function closeSessionResources(sessionId?: string): void {
	const failures: unknown[] = [];

	for (const hook of closeHooks) {
		try {
			hook(sessionId);
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(failures, "Session cleanup failed");
	}
}
