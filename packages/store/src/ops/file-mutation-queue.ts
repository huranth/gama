import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@huranth/gama-bus";
import { type ExecutionEnv, getOrThrow } from "../system/index.ts";

const queues = new Map<string, Promise<void>>();

const active = new AsyncLocalStorage<ReadonlySet<string>>();

async function mutationKey(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const absolutePath = getOrThrow(await env.absolutePath(path, context));
	return `${env.id}\0${await canonical(env, absolutePath, context)}`;
}

async function canonical(
	env: ExecutionEnv,
	absolutePath: string,
	context: Context,
): Promise<string> {
	const normalize = (path: string): string =>
		process.platform === "win32" ? path.toLowerCase() : path;
	const result = await env.canonicalPath(absolutePath, context);
	if (result.ok) return normalize(result.value);
	if (result.error.code === "not_supported") return normalize(absolutePath);
	if (result.error.code !== "not_found") throw result.error;
	const parent = getOrThrow(await env.joinPath([absolutePath, ".."], context));
	if (parent === absolutePath || !absolutePath.startsWith(parent)) return absolutePath;
	const name = absolutePath.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1));
	return normalize(
		getOrThrow(await env.joinPath([await canonical(env, parent, context), name], context)),
	);
}

export async function withFileMutationQueue<T>(
	env: ExecutionEnv,
	path: string,
	fn: () => Promise<T>,
	context: Context,
): Promise<T> {
	const key = await mutationKey(env, path, context);
	const current = active.getStore();
	if (current?.has(key)) return fn();

	const previous = queues.get(key) ?? Promise.resolve();
	let release = (): void => {};
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => done);
	queues.set(key, tail);
	const nested = new Set(current);
	nested.add(key);

	return active.run(nested, async () => {
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (queues.get(key) === tail) queues.delete(key);
		}
	});
}
