import { stripBom } from "../../../utils/text.ts";
import {
	DEFAULT_MAX_CHARS,
	MAX_BODY_BYTES,
	MAX_REDIRECTS,
	REDIRECT_STATUSES,
	USER_AGENT,
} from "./const.ts";
import { pinnedFetch } from "./pinned-fetch.ts";
import { assertUrlAllowed } from "./security/ssrf.ts";
import type { AddressPolicy, HostLookup } from "./security/ssrf.ts";

// Char limits
export const MIN_MAX_CHARS = 1_000;

export const MAX_MAX_CHARS = 50_000;

// Timeout budget
export const FETCH_TIMEOUT_MS = 30_000;

// Cut marker
export const TRUNCATED_MARKER = "\n\n[Content truncated]";

// Unicode max
const MAX_CODE_POINT = 0x10ffff;

// Abort name
const ABORT_ERROR = "AbortError";

// Request headers
const ACCEPT = "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8";

const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

export const ACCEPT_ENCODING = "gzip, deflate, br";

// Charset label
const CHARSET_PATTERN = /charset\s*=\s*["']?([^;"'\s]+)/i;

// Readable type
const SUPPORTED_TYPE =
	/^(?:text\/|application\/(?:json|xhtml\+xml|xml|rss\+xml|atom\+xml|[^;\s/]+\+json)\b)/i;

// Tag strip
const TAG_PATTERN = /<[^>]*>/g;

// Named entities
const ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	copy: "(c)",
	hellip: "...",
	gt: ">",
	lt: "<",
	mdash: "-",
	middot: "*",
	nbsp: " ",
	ndash: "-",
	quot: '"',
	rsquo: "'",
};

// Entity pattern
const ENTITY_PATTERN = /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g;

// Dropped tags
const DROP_TAGS = [
	"script",
	"style",
	"svg",
	"canvas",
	"iframe",
	"noscript",
	"nav",
	"header",
	"footer",
	"form",
	"button",
	"select",
];

// Drop patterns
const DROP_PATTERNS = DROP_TAGS.map(
	(tag) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
);

// Block ends
const BLOCK_ENDS = "p|div|section|article|main|aside|li|tr|td|th|h[1-6]|blockquote|pre";

// Block close
const BLOCK_CLOSE = new RegExp(`</(${BLOCK_ENDS})>`, "gi");

// List starts
const LIST_START = /<(li|tr|h[1-6])\b[^>]*>/gi;

// Frontmatter fields
const FIELD_FINDERS: Record<"title" | "description", RegExp> = {
	title: /^title:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m,
	description: /^description:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m,
};

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

// Extracted page
export interface ExtractedText {
	title?: string;
	description?: string;
	text: string;
}

export interface ReadUrlInput {
	url: string;
	maxChars?: number;
	fetch?: FetchLike;
	lookupHost?: HostLookup;
	isBlocked?: AddressPolicy;
	resolveDns?: boolean;
	signal?: AbortSignal;
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

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };

	const kept = text.slice(0, maxChars).trimEnd();

	return { text: `${kept}${TRUNCATED_MARKER}`, truncated: true };
}

export function isSupportedContentType(contentType: string): boolean {
	return SUPPORTED_TYPE.test(contentType.trim());
}

export function decodeHtmlEntities(text: string): string {
	return text.replace(ENTITY_PATTERN, (entity, name: string) => {
		if (name[0] !== "#") return ENTITIES[name] ?? entity;

		// Hex digits
		const isHex = name[1]?.toLowerCase() === "x";
		const digits = name.slice(isHex ? 2 : 1);
		const value = Number.parseInt(digits, isHex ? 16 : 10);

		// Range guard
		const inRange = Number.isFinite(value) && value >= 0 && value <= MAX_CODE_POINT;

		return inRange ? String.fromCodePoint(value) : entity;
	});
}

export function normalizeText(text: string): string {
	const noCR = text.replace(/\r/g, "");
	const collapsed = noCR.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n");
	const spaced = collapsed.replace(/\n{3,}/g, "\n\n");
	const lines = spaced
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	return lines.join("\n").trim();
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

// Tag strip
function stripTags(html: string): string {
	return html.replace(TAG_PATTERN, " ");
}

function extractFirstMatch(html: string, pattern: RegExp): string | undefined {
	const match = html.match(pattern);
	if (!match?.[1]) return undefined;

	return normalizeText(decodeHtmlEntities(stripTags(match[1])));
}

function extractElementContents(html: string, tagName: string): string[] {
	const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
	const contents: string[] = [];

	for (const match of html.matchAll(pattern)) {
		const inner = match[1];
		if (inner) contents.push(inner);
	}

	return contents;
}

function longestElement(html: string, tagName: string): string | undefined {
	const candidates = extractElementContents(html, tagName);
	if (candidates.length === 0) return undefined;

	let best = candidates[0]!;
	let bestLength = stripTags(best).length;

	for (const candidate of candidates.slice(1)) {
		const length = stripTags(candidate).length;
		if (length <= bestLength) continue;

		best = candidate;
		bestLength = length;
	}

	return best;
}

function selectReadableHtml(html: string): string {
	return longestElement(html, "article") ?? longestElement(html, "main") ?? html;
}

// Meta lookup
function extractMetaContent(html: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	// Both orders
	const patterns = [
		new RegExp(
			`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])(?=[^>]*content=["']([^"']*)["'])[^>]*>`,
			"i",
		),
		new RegExp(
			`<meta\\b(?=[^>]*content=["']([^"']*)["'])(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*>`,
			"i",
		),
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) return normalizeText(decodeHtmlEntities(match[1]));
	}

	return undefined;
}

export function extractHtml(html: string): ExtractedText {
	const title = extractFirstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
	const description =
		extractMetaContent(html, "description") ?? extractMetaContent(html, "og:description");

	let readable = html.replace(/<!--[\s\S]*?-->/g, "\n");
	readable = readable.replace(/<!doctype[^>]*>/gi, "\n");

	for (const pattern of DROP_PATTERNS) {
		readable = readable.replace(pattern, "\n");
	}

	readable = selectReadableHtml(readable);
	readable = readable.replace(/<br\s*\/?>/gi, "\n");
	readable = readable.replace(BLOCK_CLOSE, "\n");
	readable = readable.replace(LIST_START, "\n");
	readable = readable.replace(TAG_PATTERN, "");

	return {
		title,
		description,
		text: normalizeText(decodeHtmlEntities(readable)),
	};
}

// Field text
function frontmatterValue(frontmatter: string, key: "title" | "description"): string {
	const found = frontmatter.match(FIELD_FINDERS[key]);
	if (!found) return "";

	// Double quotes
	if (found[1] !== undefined) return normalizeText(decodeHtmlEntities(found[1]));

	// Single quotes
	if (found[2] !== undefined) return normalizeText(decodeHtmlEntities(found[2]));

	return normalizeText(decodeHtmlEntities(found[3] ?? ""));
}

export function extractMarkdownFrontmatter(body: string): ExtractedText {
	const match = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
	if (!match) return { text: normalizeText(decodeHtmlEntities(body)) };

	const frontmatter = match[1] ?? "";

	return {
		title: frontmatterValue(frontmatter, "title") || undefined,
		description: frontmatterValue(frontmatter, "description") || undefined,
		text: normalizeText(decodeHtmlEntities(body.slice(match[0].length))),
	};
}

type TextKind = "html" | "json" | "markdown" | "text";

function textKind(contentType: string): TextKind {
	const lower = contentType.toLowerCase();

	if (lower.includes("text/html") || lower.includes("application/xhtml")) return "html";
	if (lower.includes("application/json") || lower.includes("+json")) return "json";
	if (lower.includes("text/markdown")) return "markdown";

	return "text";
}

export function extractTextByContentType(contentType: string, body: string): ExtractedText {
	switch (textKind(contentType)) {
		case "html":
			return extractHtml(body);

		case "json":
			try {
				return { text: JSON.stringify(JSON.parse(body), null, 2) };
			} catch {
				return { text: normalizeText(body) };
			}

		case "markdown":
			return extractMarkdownFrontmatter(body);

		default:
			return { text: normalizeText(body) };
	}
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

// Char clamp
function clampChars(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHARS;

	const chars = Math.floor(value);

	return Math.min(Math.max(chars, MIN_MAX_CHARS), MAX_MAX_CHARS);
}

// Parse URL
function parseUrl(raw: string): URL {
	let parsed: URL;

	try {
		parsed = new URL(raw);
	} catch {
		throw new FetchError(FETCH_KINDS.invalidUrl, "Invalid URL");
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new FetchError(FETCH_KINDS.scheme, "Only http:// and https:// URLs are supported");
	}

	if (parsed.username || parsed.password) {
		throw new FetchError(FETCH_KINDS.invalidUrl, "URLs with credentials are not supported");
	}

	return parsed;
}

// Fetch context
interface FetchContext {
	fetchImpl: FetchLike;
	resolveDns: boolean;
	lookupHost?: HostLookup;
	isBlocked?: AddressPolicy;
	signal: AbortSignal;
}

// Response pair
interface PageResponse {
	response: Response;
	finalUrl: URL;
}

// Safe fetch
function fetchOnce(context: FetchContext, url: URL): Promise<Response> {
	return context.fetchImpl(url.toString(), {
		redirect: "manual",
		signal: context.signal,
		headers: {
			accept: ACCEPT,
			"accept-encoding": ACCEPT_ENCODING,
			"accept-language": ACCEPT_LANGUAGE,
			"user-agent": USER_AGENT,
		},
	});
}

// Redirect target
function resolveLocation(location: string, base: URL): URL {
	try {
		return new URL(location, base);
	} catch {
		throw new FetchError(FETCH_KINDS.redirectLocation, `Invalid redirect location: ${location}`);
	}
}

// Follow redirects
async function followRedirects(start: URL, context: FetchContext): Promise<PageResponse> {
	let currentUrl = start;
	let redirects = 0;

	while (true) {
		await assertUrlAllowed(currentUrl, {
			lookupHost: context.lookupHost,
			resolveDns: context.resolveDns,
			isBlocked: context.isBlocked,
		});

		const response = await fetchOnce(context, currentUrl);
		const location = header(response.headers, "location");
		const isRedirect = REDIRECT_STATUSES.has(response.status);

		if (!isRedirect || !location) return { response, finalUrl: currentUrl };

		await discardBody(response);
		redirects += 1;
		if (redirects > MAX_REDIRECTS) {
			throw new FetchError(FETCH_KINDS.redirects, `Too many redirects (>${MAX_REDIRECTS})`);
		}

		currentUrl = resolveLocation(location, currentUrl);
	}
}

// Read page
async function readPage(
	response: Response,
	requestedUrl: string,
	finalUrl: URL,
	maxChars: number,
): Promise<ReadUrlResult> {
	if (!response.ok) {
		await discardBody(response);
		throw new FetchError(
			FETCH_KINDS.http,
			`Failed to fetch URL: HTTP ${response.status}` +
				`${response.statusText ? ` ${response.statusText}` : ""}`,
		);
	}

	const contentType = header(response.headers, "content-type") ?? "";
	if (!contentType || !isSupportedContentType(contentType)) {
		await discardBody(response);
		throw new FetchError(
			FETCH_KINDS.contentType,
			`Unsupported content type: ${contentType.trim() || "unknown"}`,
		);
	}

	const bytes = await readResponseBody(response, MAX_BODY_BYTES);
	const body = decodeBody(bytes, contentType);
	const extracted = extractTextByContentType(contentType, body);
	const result = truncateText(extracted.text, maxChars);

	if (!result.text) {
		throw new FetchError(FETCH_KINDS.empty, "No text");
	}

	const page: ReadUrlResult = {
		url: requestedUrl,
		finalUrl: finalUrl.toString(),
		status: response.status,
		text: result.text,
		truncated: result.truncated,
	};

	if (contentType) page.contentType = contentType;
	if (extracted.title) page.title = extracted.title;
	if (extracted.description) page.description = extracted.description;

	return page;
}

// Abort mapping
function fetchFailure(error: unknown, signal?: AbortSignal): unknown {
	const isAbort = error instanceof Error && error.name === ABORT_ERROR;
	if (!isAbort) return error;

	// Caller cancel
	if (signal?.aborted) return new FetchError(FETCH_KINDS.cancelled, "Cancelled");

	return new FetchError(FETCH_KINDS.timeout, `Timed out after ${FETCH_TIMEOUT_MS} ms`);
}

export async function readUrl(input: ReadUrlInput): Promise<ReadUrlResult> {
	if (input.signal?.aborted) throw new FetchError(FETCH_KINDS.cancelled, "Cancelled");

	const requestedUrl = input.url.trim();
	const maxChars = clampChars(input.maxChars);
	const parsedUrl = parseUrl(requestedUrl);

	// Transport setup
	const fetchImpl =
		input.fetch ?? defaultTransport({ lookupHost: input.lookupHost, isBlocked: input.isBlocked });
	const resolveDns = input.resolveDns ?? input.fetch === undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => controller.abort();

	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) controller.abort();

	try {
		const { response, finalUrl } = await followRedirects(parsedUrl, {
			fetchImpl,
			resolveDns,
			lookupHost: input.lookupHost,
			isBlocked: input.isBlocked,
			signal: controller.signal,
		});

		return await readPage(response, requestedUrl, finalUrl, maxChars);
	} catch (error) {
		throw fetchFailure(error, input.signal);
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", onAbort);
	}
}
