import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

type QueueEntry = {
	key: string;
	currentQueue: Promise<void>;
	chainedQueue: Promise<void>;
	release: () => void;
};

type Deferred = { promise: Promise<void>; release: () => void };

const fileMutationQueues = new Map<string, Promise<void>>();

const activeQueues = new AsyncLocalStorage<ReadonlySet<string>>();

let lock = Promise.resolve();

function normalizeKey(key: string): string {
	return process.platform === "win32" ? key.toLowerCase() : key;
}

function isMissingPathError(error: unknown): boolean {
	const isCoded = error instanceof Error && "code" in error;

	return isCoded && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function createDeferred(): Deferred {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});

	return { promise, release };
}

async function getQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);

	try {
		const real = await realpath(resolvedPath);

		return normalizeKey(real);
	} catch (error) {
		// Case fold
		if (isMissingPathError(error)) return normalizeKey(resolvedPath);

		throw error;
	}
}

// Join queue
function createEntry(key: string): QueueEntry {
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
	const deferred = createDeferred();
	const chainedQueue = currentQueue.then(() => deferred.promise);

	fileMutationQueues.set(key, chainedQueue);

	return { key, currentQueue, chainedQueue, release: deferred.release };
}

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const pending = lock.then(async () => {
		const key = await getQueueKey(filePath);

		// Reentrancy
		if (activeQueues.getStore()?.has(key)) return undefined;

		return createEntry(key);
	});

	lock = pending.then(
		() => undefined,
		() => undefined,
	);

	const entry = await pending;

	if (!entry) return fn();

	await entry.currentQueue;

	const active = new Set(activeQueues.getStore() ?? []);
	active.add(entry.key);

	try {
		return await activeQueues.run(active, fn);
	} finally {
		entry.release();

		if (fileMutationQueues.get(entry.key) === entry.chainedQueue) {
			fileMutationQueues.delete(entry.key);
		}
	}
}
