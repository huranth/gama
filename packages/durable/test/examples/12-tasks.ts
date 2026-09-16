import { BACKGROUND_CONTEXT } from "@huranth/chord/context";
import { createModels } from "@huranth/gama-ai/models";
import {
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

const payments = new Map<string, number>();
type PaymentState = { phase: "prepare" } | { phase: "charge"; key: string };
const Payment = defineTask<{ amount: number }, PaymentState, { receipt: number }>({
	name: "example.payment",
	version: 1,
	initial: () => ({ phase: "prepare" }),
	phases: {
		prepare: async (task, runtime, taskContext) => {
			await runtime.commit(
				() => ({
					status: "running",
					checkpoint: { phase: "charge", key: `payment-${task.id}` },
				}),
				taskContext,
			);
		},
		charge: async (task, runtime, taskContext) => {
			const key = task.state.checkpoint.key;
			if (!payments.has(key)) payments.set(key, task.input.amount * 100);
			const receipt = payments.get(key)!;
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: { receipt } } }),
				taskContext,
			);
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
registry.install(defineExtension({ name: "payments", tasks: [Payment] }));
const harness = await Harness.open(
	new MemoryStorage(),
	{ models: createModels(), registry },
	context,
);
const root = await harness.root(context);
const paymentId = await root.commit(
	(tx) => tx.createTask(Payment, { amount: 5 }, { ownership: { kind: "conversation" } }),
	context,
);
const paid = await harness.waitForTask(paymentId, context);
console.log("payment outcome:", paid.state.outcome);

await harness.close(context);
