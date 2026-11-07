import { Worker } from "node:worker_threads";
import { exitCodeLabel } from "../core/exit-code.ts";
import {
	type ImageResizeOptions,
	type ResizedImage,
	resizeImageInProcess,
} from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

// Bun path
const bunWorkerSource = "./src/utils/image-resize-worker.ts";

export const IMAGE_RESIZE_WORKER_TIMEOUT_MS = 10_000;

function getWorkerUrl(): URL {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerFile = isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js";

	return new URL(workerFile, import.meta.url);
}

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(input);
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return value !== null && typeof value === "object";
}

export async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const worker = new Worker(workerSpecifier);
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);

		return await new Promise<ResizedImage | null>((resolve, reject) => {
			let settled = false;

			const settle = (result: ResizedImage | null): void => {
				if (settled) {
					return;
				}

				settled = true;
				if (timer) clearTimeout(timer);
				resolve(result);
			};

			const fail = (error: Error): void => {
				if (settled) {
					return;
				}

				settled = true;
				if (timer) clearTimeout(timer);
				reject(error);
			};

			timer = setTimeout(
				() => fail(new Error("Worker timed out")),
				IMAGE_RESIZE_WORKER_TIMEOUT_MS,
			);

			worker.once("message", (message: unknown) => {
				if (!isResizeImageWorkerResponse(message)) {
					fail(new Error("Invalid worker response"));
					return;
				}

				if (message.error) {
					fail(new Error(message.error));
					return;
				}

				settle(message.result ?? null);
			});

			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (settled) {
					return;
				}

				fail(new Error(`Worker failed: ${exitCodeLabel(code)}`));
			});

			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		if (timer) clearTimeout(timer);
		void worker.terminate().catch(() => undefined);
	}
}

export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const workerUrl = getWorkerUrl();

	if (typeof process.versions.bun === "string") {
		try {
			return await resizeImageInWorker(bunWorkerSource, inputBytes, mimeType, options);
		} catch {}
	}

	try {
		return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
	} catch (error) {
		if (error instanceof Error && error.message.includes("timed out")) throw error;
		return resizeImageInProcess(inputBytes, mimeType, options);
	}
}

export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;

	return (
		`[Image: original ${result.originalWidth}x${result.originalHeight}, ` +
		`displayed at ${result.width}x${result.height}. ` +
		`Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`
	);
}
