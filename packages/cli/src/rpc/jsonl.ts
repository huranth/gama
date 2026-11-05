import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	onError?: (error: Error) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const MAX_LINE_BYTES = 10 * 1024 * 1024;

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");
		}

		if (buffer.length > MAX_LINE_BYTES) {
			emitLine(buffer);
			buffer = "";
		}
	};

	const flushBuffer = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	const onEnd = () => {
		flushBuffer();
	};

	const onStreamError = (error: Error) => {
		buffer = "";
		onError?.(error);
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	stream.on("error", onStreamError);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.off("error", onStreamError);
	};
}
