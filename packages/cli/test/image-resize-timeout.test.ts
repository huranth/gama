import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ terminate: vi.fn() }));

vi.mock("node:worker_threads", () => ({
	Worker: class {
		constructor(_specifier: string | URL) {}

		once(_event: string, _listener: (...args: unknown[]) => void): void {}

		postMessage(_value: unknown, _transfer?: readonly unknown[]): void {}

		terminate(): Promise<void> {
			fake.terminate();
			return Promise.resolve();
		}
	},
}));

import {
	IMAGE_RESIZE_WORKER_TIMEOUT_MS,
	resizeImageInWorker,
} from "../src/utils/image-resize.ts";

describe("image resize worker", () => {
	it("terminates a hung worker after the deadline", async () => {
		vi.useFakeTimers();

		try {
			const pending = resizeImageInWorker("worker", new Uint8Array([1]), "image/png");
			const rejected = expect(pending).rejects.toThrow("timed out");

			await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_WORKER_TIMEOUT_MS);
			await rejected;

			expect(fake.terminate).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
