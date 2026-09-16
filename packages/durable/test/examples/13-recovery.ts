import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createModels } from "@huranth/gama-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const context = BACKGROUND_CONTEXT;

const directory = await mkdtemp(join(tmpdir(), "gama-durable-example-"));
const databasePath = join(directory, "session.sqlite");

let reachedTick = (_n: number): void => {};
const Ticker = defineTask<{ to: number }, { phase: "tick"; n: number }, string>({
	name: "example.ticker",
	version: 1,
	initial: () => ({ phase: "tick", n: 1 }),
	phases: {
		tick: async (task, runtime, taskContext) => {
			const n = task.state.checkpoint.n;
			if ((await runtime.memo(`printed-${n}`, taskContext)) === undefined) {
				await runtime.memo(`printed-${n}`, true, taskContext);
				console.log(`tick ${n}`);
			}
			reachedTick(n);
			await runtime.commit(
				() =>
					n === task.input.to
						? {
								status: "terminal",
								outcome: { status: "completed", result: `counted to ${n}` },
							}
						: { status: "running", checkpoint: { phase: "tick", n: n + 1 } },
				taskContext,
			);
			await runtime.sleep(Date.now() + 50, taskContext);
		},
	},
	abort: async (_task, runtime, taskContext) => {
		await runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }),
			taskContext,
		);
	},
});
const registry = createRegistry();
registry.install(defineExtension({ name: "ticker", tasks: [Ticker] }));
const open = async () =>
	Harness.open(
		await openNodeSqliteStorage(databasePath),
		{ models: createModels(), registry },
		context,
	);

const firstRun = await open();
const tickerId = await (await firstRun.root(context)).commit(
	(tx) => tx.createTask(Ticker, { to: 5 }, { ownership: { kind: "conversation" } }),
	context,
);
const tickTwo = new Promise<void>((resolve) => {
	reachedTick = (n) => {
		if (n === 2) resolve();
	};
});
firstRun.resume();
await tickTwo;
await firstRun.close(context);
reachedTick = () => {};

const reader = await open();
const saved = (await reader.getTask(tickerId, context))!;
await reader.close(context);
console.log("closed; saved checkpoint:", saved.state, "memos:", saved.memos);

const secondRun = await open();
const counted = await secondRun.waitForTask(tickerId, context);
console.log("after reopen:", counted.state.outcome);
await secondRun.close(context);
await rm(directory, { recursive: true, force: true });
