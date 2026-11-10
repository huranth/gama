import { describe, expect, it } from "vitest";
import { CodemodeSandbox } from "../src/index.ts";
import { isWorkerToHostMessage } from "../src/sandbox/protocol.ts";

const execute = () => undefined;

describe("worker protocol guards", () => {
	it("accepts complete payloads", () => {
		expect(
			isWorkerToHostMessage({ type: "call", id: 1, target: "tool", name: "echo", args: "{}" }),
		).toBe(true);
		expect(
			isWorkerToHostMessage({
				type: "call",
				id: 1,
				target: "global",
				name: "fs.read",
				args: undefined,
			}),
		).toBe(true);
		expect(isWorkerToHostMessage({ type: "output", item: { type: "text", text: "hi" } })).toBe(
			true,
		);
		expect(
			isWorkerToHostMessage({
				type: "output",
				item: { type: "image", data: "x", mimeType: "image/png" },
			}),
		).toBe(true);
		expect(isWorkerToHostMessage({ type: "done", ok: true, value: "1", writes: "[]" })).toBe(
			true,
		);
		expect(isWorkerToHostMessage({ type: "done", ok: false, error: "boom" })).toBe(true);
		expect(isWorkerToHostMessage({ type: "crash", message: "boom" })).toBe(true);
	});

	it("rejects payloads with missing or wrong fields", () => {
		expect(isWorkerToHostMessage({ type: "call", id: "1", target: "tool" })).toBe(false);
		expect(isWorkerToHostMessage({ type: "call", id: 1, target: "other", name: "echo" })).toBe(
			false,
		);
		expect(
			isWorkerToHostMessage({ type: "call", id: 1, target: "tool", name: "echo", args: 5 }),
		).toBe(false);
		expect(isWorkerToHostMessage({ type: "output", item: { type: "text" } })).toBe(false);
		expect(isWorkerToHostMessage({ type: "output", item: { type: "image", data: "x" } })).toBe(
			false,
		);
		expect(isWorkerToHostMessage({ type: "output", item: { type: "audio" } })).toBe(false);
		expect(isWorkerToHostMessage({ type: "done", ok: true })).toBe(false);
		expect(isWorkerToHostMessage({ type: "done", ok: false })).toBe(false);
		expect(isWorkerToHostMessage({ type: "done", ok: "yes", error: "boom" })).toBe(false);
		expect(isWorkerToHostMessage({ type: "crash" })).toBe(false);
		expect(isWorkerToHostMessage({ type: "unknown" })).toBe(false);
		expect(isWorkerToHostMessage(null)).toBe(false);
	});
});

describe("CodemodeSandbox guards", () => {
	it("rejects reserved tool identifiers", () => {
		expect(() => new CodemodeSandbox({ tools: [{ name: "store", execute }] })).toThrow(
			/Reserved/,
		);
	});

	it("keeps __proto__ as an own store key", async () => {
		const sandbox = new CodemodeSandbox();
		try {
			const result = await sandbox.execute("store('__proto__', { polluted: true });", {
				store: {},
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(Object.hasOwn(result.storeWrites.set, "__proto__")).toBe(true);
			expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
		} finally {
			await sandbox.close();
		}
	});

	it("rejects invalid timeouts", async () => {
		const sandbox = new CodemodeSandbox();
		try {
			await expect(sandbox.execute("return 1", { timeoutMs: -1 })).rejects.toThrow("timeoutMs");
			await expect(sandbox.execute("return 1", { timeoutMs: Number.NaN })).rejects.toThrow(
				"timeoutMs",
			);
		} finally {
			await sandbox.close();
		}
	});
});
