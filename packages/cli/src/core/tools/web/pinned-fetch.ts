import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net from "node:net";
import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import zlib from "node:zlib";
import {
	type AddressPolicy,
	decodeIpv4Literal,
	type HostLookup,
	isBlockedAddress,
	unwrapHost,
	validatingLookup,
} from "./security/ssrf.ts";

// Status range
const MIN_STATUS = 200;

const MAX_STATUS = 599;

// Empty bodies
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Requested codings
const ACCEPT_ENCODING = "gzip, deflate, br";

// Known decoders
const DECODERS = new Map<string, () => NodeJS.ReadWriteStream>([
	["gzip", () => zlib.createGunzip()],
	["x-gzip", () => zlib.createGunzip()],
	["deflate", () => flexibleInflate()],
	["br", () => zlib.createBrotliDecompress()],
]);

function abortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function contentEncodings(response: IncomingMessage): string[] {
	return String(response.headers["content-encoding"] ?? "")
		.toLowerCase()
		.split(",")
		.map((encoding) => encoding.trim())
		.filter((encoding) => encoding && encoding !== "identity");
}

function decoderFor(encoding: string): NodeJS.ReadWriteStream | undefined {
	return DECODERS.get(encoding)?.();
}

function decodedBody(response: IncomingMessage, encodings: string[]): Readable {
	let body: Readable = response;

	// Reverse order
	for (const encoding of [...encodings].reverse()) {
		const decoder = decoderFor(encoding);
		if (!decoder) {
			response.destroy();
			throw new Error(`Unsupported content-encoding: ${encoding}`);
		}
		body = pipeline(body, decoder, () => {}) as unknown as Readable;
	}

	return body;
}

function toResponse(response: IncomingMessage): Response {
	const status = response.statusCode ?? 0;
	if (status < MIN_STATUS || status > MAX_STATUS) {
		response.destroy();
		throw new Error("Bad status");
	}

	const encodings = contentEncodings(response);
	const headers = new Headers();
	const decoding = encodings.length > 0;

	for (const [name, value] of Object.entries(response.headers)) {
		if (value === undefined) continue;
		if (decoding && (name === "content-encoding" || name === "content-length")) continue;

		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else {
			headers.set(name, value);
		}
	}

	if (NULL_BODY_STATUSES.has(status)) {
		response.resume();
		return new Response(null, {
			status,
			statusText: response.statusMessage,
			headers,
		});
	}

	try {
		return new Response(Readable.toWeb(decodedBody(response, encodings)), {
			status,
			statusText: response.statusMessage,
			headers,
		});
	} catch (error) {
		response.destroy();
		throw error;
	}
}

// DNS pinned
export function pinnedFetch(
	url: string | URL,
	init: {
		headers?: Record<string, string>;
		signal?: AbortSignal;
		lookupHost?: HostLookup;
		isBlocked?: AddressPolicy;
	} = {},
): Promise<Response> {
	const target = typeof url === "string" ? new URL(url) : url;
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		return Promise.reject(new Error("Bad URL"));
	}

	const signal = init.signal;
	if (signal?.aborted) return Promise.reject(abortError());

	const host = unwrapHost(target.hostname);
	const blocked = init.isBlocked ?? isBlockedAddress;

	// Literal check
	const literal = net.isIP(host) !== 0 ? host : decodeIpv4Literal(host);
	if (literal && blocked(literal)) {
		return Promise.reject(new Error("Private address blocked"));
	}

	const transport = target.protocol === "https:" ? https : http;

	return new Promise<Response>((resolve, reject) => {
		const request = transport.request({
			protocol: target.protocol,
			hostname: host,
			port: target.port || undefined,
			path: `${target.pathname}${target.search}`,
			method: "GET",
			headers: {
				...init.headers,
				"accept-encoding": ACCEPT_ENCODING,
			},
			// No reuse
			agent: false,
			lookup: validatingLookup({
				lookupHost: init.lookupHost,
				isBlocked: blocked,
			}),
		});

		let response: IncomingMessage | undefined;
		const onAbort = () => {
			const error = abortError();
			// Error guard
			response?.on("error", () => {});
			request.destroy(error);
			response?.destroy(error);
			reject(error);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		const done = () => signal?.removeEventListener("abort", onAbort);

		request.on("error", (error) => {
			done();
			reject(error);
		});

		request.on("response", (incoming) => {
			response = incoming;
			incoming.on("close", done);

			if (signal?.aborted) {
				incoming.on("error", () => {});
				incoming.destroy();
				done();
				return;
			}

			try {
				resolve(toResponse(incoming));
			} catch (error) {
				done();
				reject(error);
			}
		});

		request.on("close", () => {
			if (response) return;
			done();
			reject(new Error("Connection closed"));
		});

		request.end();
	});
}

// Zlib checksum
function isZlibHeader(head: Buffer): boolean {
	const method = head[0]! & 0x0f;
	if (method !== 8) return false;

	return ((head[0]! << 8) | head[1]!) % 31 === 0;
}

// Lenient inflate
function flexibleInflate(): Transform {
	let decoder: zlib.Inflate | zlib.InflateRaw | undefined;
	let head: Buffer | undefined;

	const bridge = new Transform({
		transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
			if (decoder) {
				decoder.write(chunk, callback);
				return;
			}

			head = head ? Buffer.concat([head, chunk]) : chunk;
			if (head.length < 2) {
				callback();
				return;
			}

			decoder = isZlibHeader(head) ? zlib.createInflate() : zlib.createInflateRaw();
			decoder.on("data", (data: Buffer) => {
				if (!bridge.push(data)) decoder!.pause();
			});
			decoder.on("end", () => bridge.push(null));
			decoder.on("error", (error: Error) => bridge.destroy(error));
			bridge.on("drain", () => decoder!.resume());
			bridge.on("close", () => decoder?.destroy());
			decoder.write(head, callback);
		},
		final(callback: TransformCallback) {
			if (!decoder) {
				callback();
				return;
			}
			if (!decoder.destroyed) decoder.end();
			// Flush first
			decoder.once("end", () => callback());
		},
	});

	return bridge;
}
