import { stripBom } from "../../../utils/text.ts";
import { pinnedFetch } from "./pinned-fetch.ts";
import type { AddressPolicy, HostLookup } from "./security/ssrf.ts";

// Char limits
export const MIN_MAX_CHARS = 1_000;

export const MAX_MAX_CHARS = 50_000;

// Timeout budget
export const FETCH_TIMEOUT_MS = 30_000;

// Request headers
export const ACCEPT_ENCODING = "gzip, deflate, br";

// Charset label
const CHARSET_PATTERN = /charset\s*=\s*["']?([^;"'\s]+)/i;

// Readable type
const SUPPORTED_TYPE =
	/^(?:text\/|application\/(?:json|xhtml\+xml|xml|rss\+xml|atom\+xml|[^;\s/]+\+json)\b)/i;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ReadUrlResult {
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	description?: string;
	text: string;
	truncated: boolean;
}

export const FETCH_KINDS = {
	blocked: "blocked",
	cancelled: "cancelled",
	contentType: "content-type",
	empty: "empty",
	http: "http",
	invalidUrl: "invalid-url",
	redirectLocation: "redirect-location",
	redirects: "redirects",
	scheme: "scheme",
	timeout: "timeout",
	tooLarge: "too-large",
} as const;

export class FetchError extends Error {
	readonly kind: string;

	constructor(kind: string, message: string) {
		super(message);
		this.name = "FetchError";
		this.kind = kind;
	}
}

// Header lookup
export function header(headers: Headers, name: string): string | undefined {
	return headers.get(name) ?? undefined;
}

// Drop body
export async function discardBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => {});
}

// BOM strip
export { stripBom };

export function isSupportedContentType(contentType: string): boolean {
	return SUPPORTED_TYPE.test(contentType.trim());
}

export function decodeBody(body: Uint8Array, contentType: string): string {
	const charset = CHARSET_PATTERN.exec(contentType)?.[1];
	let text: string;

	try {
		text = new TextDecoder(charset).decode(body);
	} catch {
		text = new TextDecoder().decode(body);
	}

	return stripBom(text);
}

export async function readResponseBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	const contentLength = header(response.headers, "content-length");
	if (contentLength && Number(contentLength) > maxBytes) {
		await discardBody(response);
		throw new FetchError(
			FETCH_KINDS.tooLarge,
			`Response is too large (${contentLength} bytes); no partial body is returned`,
		);
	}

	if (!response.body) return readWholeBody(response, maxBytes);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new FetchError(
					FETCH_KINDS.tooLarge,
					`Response exceeded ${maxBytes} bytes; no partial body is returned`,
				);
			}

			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	return concatChunks(chunks, totalBytes);
}

// Whole body
async function readWholeBody(response: Response, maxBytes: number): Promise<Uint8Array> {
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength <= maxBytes) return new Uint8Array(buffer);

	throw new FetchError(
		FETCH_KINDS.tooLarge,
		`Response is too large (${buffer.byteLength} bytes); no partial body is returned`,
	);
}

// Join chunks
function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
	const body = new Uint8Array(totalBytes);
	let offset = 0;

	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return body;
}

// Header record
function headerRecord(headers: RequestInit["headers"]): Record<string, string> | undefined {
	if (!headers) return undefined;

	const record: Record<string, string> = {};
	new Headers(headers).forEach((value, key) => {
		record[key] = value;
	});

	return record;
}

export function defaultTransport(options: {
	lookupHost?: HostLookup;
	isBlocked?: AddressPolicy;
}): FetchLike {
	return async (input, init) =>
		pinnedFetch(String(input), {
			headers: headerRecord(init?.headers),
			signal: init?.signal ?? undefined,
			...options,
		});
}
