import { parentPort, workerData } from "node:worker_threads";
import { JSException, type JSValueHandle, MAX_STACK_SIZE, QuickJS } from "quickjs-wasi";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import { isHostToWorkerMessage, type WorkerData, type WorkerToHostMessage } from "./protocol.ts";

function post(message: WorkerToHostMessage): void {
	parentPort?.postMessage(message);
}

function crash(error: unknown): void {
	const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

	post({ type: "crash", message });
}

function discardOutput(memory: { readonly buffer: ArrayBufferLike }) {
	return {
		fd_write(_fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
			const view = new DataView(memory.buffer);
			let written = 0;
			for (let i = 0; i < iovsLen; i++) {
				written += view.getUint32(iovsPtr + i * 8 + 4, true);
			}

			view.setUint32(nwrittenPtr, written, true);
			return 0;
		},
	};
}

function describeException(error: JSException): string {
	const head = error.message ? `${error.name}: ${error.message}` : error.name;
	const stack = error.stack?.trimEnd();

	return JSON.stringify({
		name: error.name,
		message: error.message,
		stack: stack ? `${head}\n${stack}` : head,
	});
}

async function main(data: WorkerData): Promise<void> {
	const interrupt = new Int32Array(data.interrupt);
	const vm = await QuickJS.create({
		wasm: data.wasm,
		memoryLimit: data.memoryLimitBytes,
		maxStackSize: MAX_STACK_SIZE,
		interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
		wasi: discardOutput,
	});

	const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
		switch (kind.toString()) {
			case "call":
			case "global":
				post({
					type: "call",
					id: a.toNumber(),
					target: kind.toString() === "call" ? "tool" : "global",
					name: b.toString(),
					args: c === undefined || c.isUndefined ? undefined : c.toString(),
				});
				break;
			case "output":
				post({
					type: "output",
					item:
						a.toString() === "image"
							? { type: "image", data: b.toString(), mimeType: c.toString() }
							: { type: "text", text: b.toString() },
				});
				break;
			case "done":
				if (a.toBoolean()) {
					post({
						type: "done",
						ok: true,
						value: b === undefined || b.isUndefined ? undefined : b.toString(),
						writes: c.toString(),
					});
				} else {
					post({ type: "done", ok: false, error: b.toString() });
				}
				break;
		}
		return vm.undefined;
	});

	const api = vm.withScope((scope) =>
		scope.escape(
			vm.callFunction(
				vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
				vm.undefined,
				bridge,
				vm.newString(JSON.stringify(data.tools)),
				vm.newString(JSON.stringify(data.globals)),
				vm.newString(JSON.stringify(data.store)),
			),
		),
	);
	const settle = api.getProp("settle");
	const run = api.getProp("run");
	const stalled = api.getProp("stalled");
	const drain = () => {
		vm.executePendingJobs();
		vm.callFunction(stalled, api).dispose();
	};

	parentPort?.on("message", (message: unknown) => {
		if (!isHostToWorkerMessage(message)) return;
		try {
			vm.withScope(() => {
				vm.callFunction(
					settle,
					api,
					vm.newNumber(message.id),
					message.ok ? vm.true : vm.false,
					message.payload === undefined ? vm.undefined : vm.newString(message.payload),
				).dispose();
			});
			drain();
		} catch (error) {
			crash(error);
		}
	});

	let fn: JSValueHandle;
	try {
		fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, "codemode.js");
	} catch (error) {
		if (!(error instanceof JSException)) throw error;
		post({ type: "done", ok: false, error: describeException(error) });
		return;
	}
	vm.callFunction(run, api, fn).dispose();
	fn.dispose();
	drain();
}

if (parentPort) {
	main(workerData as WorkerData).catch(crash);
}
