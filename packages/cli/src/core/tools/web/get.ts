import { browserFetch } from "./browser.ts";
import {
	DEFAULT_MAX_CHARS,
	MAX_BODY_BYTES,
	MAX_REDIRECTS,
	REDIRECT_STATUSES,
	USER_AGENT,
} from "./const.ts";
import { extractMarkdownFrontmatter } from "./extract/frontmatter.ts";
import { type ExtractedContent, extractReadableHtml } from "./extract/readability.ts";
import { normalizeText, truncateParagraphs } from "./extract/text.ts";
import {
	ACCEPT_ENCODING,
	decodeBody,
	defaultTransport,
	discardBody,
	FETCH_KINDS,
	FETCH_TIMEOUT_MS,
	FetchError,
	type FetchLike,
	header,
	isSupportedContentType,
	MAX_MAX_CHARS,
	MIN_MAX_CHARS,
	type ReadUrlResult,
	readResponseBody,
	stripBom,
} from "./read-url.ts";
import type { AddressPolicy, HostLookup } from "./security/ssrf.ts";
import { assertUrlAllowed } from "./security/ssrf.ts";

// Challenge page
const CHALLENGE_MAX_CHARS = 12_000;

const CHALLENGE_TEXT = new RegExp(
	[
		"captcha",
		"just a moment",
		"enable javascript",
		"access denied",
		"performing security verification",
		"security verification",
		"checking your browser",
		"verify you are (?:a )?human",
		"prove your humanity",
		"are you a robot",
		"human verification",
		"security check",
		"checking if the site connection is secure",
		"complete the action below",
		"verification successful",
		"security service to protect",
		"malicious bots",
		"waiting for .* to respond",
		"please wait for verification",
		"cf-challenge",
		"challenge-platform",
		"turnstile",
		"ray id",
		"ddos protection",
		"bot protection",
		"attention required",
	].join("|"),
	"i",
);

const CHALLENGE_TITLE = new RegExp(
	[
		"just a moment",
		"attention required",
		"security verification",
		"access denied",
		"prove your humanity",
		"human verification",
		"security check",
		"are you a robot",
		"please wait for verification",
	].join("|"),
	"i",
);

// Charset sniff
const SNIFF_CHARS = 2_048;

// Full text
export const MAX_FULL_CHARS = MAX_BODY_BYTES;

// Empty page
const EMPTY_MESSAGE = "No text";

export interface FetchPageInput {
	url: string;
	maxChars?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: FetchLike;
	dnsResolve?: boolean;
	maxRedirects?: number;
	maxBytes?: number;
	lookupHost?: HostLookup;
	isBlocked?: AddressPolicy;
	fullText?: boolean;
	browserFallback?: boolean;
}

export interface FetchPageResult extends ReadUrlResult {
	fetchedAt: number;
	totalChars?: number;
	note?: string;
}

function clampChars(value: number | undefined): number {
	const chars =
		value === undefined || !Number.isFinite(value) ? DEFAULT_MAX_CHARS : Math.floor(value);

	return Math.min(Math.max(chars, MIN_MAX_CHARS), MAX_MAX_CHARS);
}

function clampNumber(value: number | undefined, fallback: number, min: number): number {
	if (value === undefined || !Number.isFinite(value) || value < min) return fallback;

	return Math.floor(value);
}

function supportsCharset(label: string): boolean {
	try {
		new TextDecoder(label);
		return true;
	} catch {
		return false;
	}
}

function decodeCharset(body: Uint8Array, contentType: string): string {
	const headerCharset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
	const text = decodeBody(body, contentType);
	if (headerCharset && supportsCharset(headerCharset)) return text;

	const head = text.slice(0, SNIFF_CHARS);
	const meta =
		/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
		/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
	if (!meta || /^utf-?8$/i.test(meta)) return text;

	try {
		return stripBom(new TextDecoder(meta).decode(body));
	} catch {
		return text;
	}
}

function isHtmlContentType(contentType: string): boolean {
	const lower = contentType.toLowerCase();

	return lower.includes("text/html") || lower.includes("application/xhtml");
}

function isChallengePage(text: string, title: string | undefined, contentType: string): boolean {
	if (!isHtmlContentType(contentType)) return false;
	if (text.length > CHALLENGE_MAX_CHARS) return false;
	if (title && CHALLENGE_TITLE.test(title)) return true;

	return CHALLENGE_TEXT.test(text.slice(0, SNIFF_CHARS));
}

const SHORT_PAGE_CHARS = 240;

const SOFT_WALL_PATTERN = new RegExp(
	[
		"before you continue",
		"please click here",
		"consent to continue",
		"we value your privacy",
		"manage cookies",
		"accept all cookies",
		"sign in to continue",
		"log in to continue",
	].join("|"),
	"i",
);

function softPageNotes(text: string, totalChars: number, contentType: string): string[] {
	if (!isHtmlContentType(contentType)) return [];

	const notes: string[] = [];
	if (totalChars > 0 && totalChars < SHORT_PAGE_CHARS) {
		notes.push(`Short page (${totalChars} chars); verify this is not a block or consent wall`);
	}
	if (SOFT_WALL_PATTERN.test(text.slice(0, 1_000))) {
		notes.push("Page may be a consent or interstitial wall; verify before trusting it");
	}

	return notes;
}

function extractByContentType(contentType: string, body: string): ExtractedContent {
	const lower = contentType.toLowerCase();

	if (isHtmlContentType(contentType)) {
		try {
			return extractReadableHtml(body, Number.MAX_SAFE_INTEGER);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (message === EMPTY_MESSAGE) {
				throw new FetchError(FETCH_KINDS.empty, EMPTY_MESSAGE);
			}
			throw error;
		}
	}

	if (lower.includes("xml") || lower.includes("rss") || lower.includes("atom")) {
		return { text: normalizeText(body), truncated: false };
	}

	if (lower.includes("markdown")) {
		const doc = extractMarkdownFrontmatter(body);

		return {
			...(doc.title ? { title: doc.title } : {}),
			...(doc.description ? { description: doc.description } : {}),
			text: doc.text,
			truncated: false,
		};
	}

	if (lower.startsWith("text/")) {
		return { text: normalizeText(body), truncated: false };
	}

	if (lower.includes("application/json") || lower.includes("+json")) {
		let text: string;

		try {
			text = JSON.stringify(JSON.parse(body), null, 2);
		} catch {
			text = normalizeText(body);
		}

		return { text, truncated: false };
	}

	throw new FetchError(
		FETCH_KINDS.contentType,
		`Unsupported content type: ${contentType.trim() || "unknown"}`,
	);
}

// Browser trigger
function shouldRender(error: unknown): boolean {
	if (!(error instanceof FetchError)) return false;

	return (
		error.kind === FETCH_KINDS.blocked ||
		error.kind === FETCH_KINDS.contentType ||
		error.kind === FETCH_KINDS.empty
	);
}

// Browser result
async function renderPage(
	input: FetchPageInput,
	url: URL,
	maxChars: number,
	timeoutMs: number,
	maxBytes: number,
): Promise<FetchPageResult> {
	// Gate browser
	await assertUrlAllowed(url, {
		lookupHost: input.lookupHost,
		resolveDns: true,
		isBlocked: input.isBlocked,
	});

	const rendered = await browserFetch(url.toString(), {
		signal: input.signal,
		timeoutMs,
		allowRequest: async (requestUrl) => {
			const request = new URL(requestUrl);

			await assertUrlAllowed(request, {
				lookupHost: input.lookupHost,
				resolveDns: true,
				isBlocked: input.isBlocked,
			});
		},
	});

	if (Buffer.byteLength(rendered.html, "utf8") > maxBytes) {
		throw new FetchError(FETCH_KINDS.tooLarge, `Rendered page is over ${maxBytes} bytes`);
	}

	if (isChallengePage(rendered.html, rendered.title, "text/html")) {
		throw new FetchError(FETCH_KINDS.blocked, "Blocked by a security challenge page");
	}

	if (rendered.finalUrl) {
		try {
			await assertUrlAllowed(new URL(rendered.finalUrl), {
				lookupHost: input.lookupHost,
				resolveDns: true,
				isBlocked: input.isBlocked,
			});
		} catch (error) {
			throw new FetchError(
				FETCH_KINDS.blocked,
				error instanceof Error ? error.message : "Blocked by address policy",
			);
		}
	}

	const extracted = extractByContentType("text/html", rendered.html);
	const pageTitle = rendered.title || extracted.title;
	if (isChallengePage(extracted.text, pageTitle, "text/html")) {
		throw new FetchError(FETCH_KINDS.blocked, "Blocked by a security challenge page");
	}
	if (!extracted.text) throw new FetchError(FETCH_KINDS.empty, EMPTY_MESSAGE);

	const totalChars = extracted.text.length;
	const cut = truncateParagraphs(extracted.text, maxChars);
	const capped = totalChars > maxChars;
	const notes = ["Rendered with local Chrome"];
	if (capped) notes.push(`Content capped at ${maxChars} chars`);
	notes.push(...softPageNotes(extracted.text, totalChars, "text/html"));

	return {
		url: input.url.trim(),
		finalUrl: rendered.finalUrl || url.toString(),
		status: 200,
		contentType: "text/html",
		...(pageTitle ? { title: pageTitle } : {}),
		...(extracted.description ? { description: extracted.description } : {}),
		text: cut.text,
		truncated: cut.truncated,
		totalChars,
		note: notes.join("; "),
		fetchedAt: Date.now(),
	};
}

export async function fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
	if (input.signal?.aborted) {
		throw new FetchError(FETCH_KINDS.cancelled, "Cancelled");
	}

	const maxChars = input.fullText ? MAX_FULL_CHARS : clampChars(input.maxChars);
	const timeoutMs = clampNumber(input.timeoutMs, FETCH_TIMEOUT_MS, 1);
	const maxBytes = clampNumber(input.maxBytes, MAX_BODY_BYTES, 1);
	const maxRedirects = clampNumber(input.maxRedirects, MAX_REDIRECTS, 0);
	const transport = { lookupHost: input.lookupHost, isBlocked: input.isBlocked };
	const fetchImpl = input.fetchImpl ?? defaultTransport(transport);
	const browserFallback = input.browserFallback ?? input.fetchImpl === undefined;

	// DNS lookup
	const resolveDns = input.dnsResolve ?? false;

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(input.url.trim());
	} catch {
		throw new FetchError(FETCH_KINDS.invalidUrl, "Invalid URL");
	}

	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new FetchError(FETCH_KINDS.scheme, "Only http:// and https:// URLs are supported");
	}

	if (parsedUrl.username || parsedUrl.password) {
		throw new FetchError(FETCH_KINDS.invalidUrl, "URLs with credentials are not supported");
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();

	input.signal?.addEventListener("abort", onAbort, { once: true });
	if (input.signal?.aborted) controller.abort();

	let currentUrl = parsedUrl;

	try {
		let response: Response;

		for (let redirects = 0; ; redirects++) {
			// Pinned recheck
			await assertUrlAllowed(currentUrl, {
				lookupHost: input.lookupHost,
				resolveDns,
				isBlocked: input.isBlocked,
			});

			response = await fetchImpl(currentUrl.toString(), {
				redirect: "manual",
				signal: controller.signal,
				headers: {
					accept:
						"text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
					"accept-encoding": ACCEPT_ENCODING,
					"accept-language": "en-US,en;q=0.9",
					"user-agent": USER_AGENT,
				},
			});

			if (!REDIRECT_STATUSES.has(response.status)) break;

			const location = header(response.headers, "location");
			if (!location) break;

			await discardBody(response);
			if (redirects >= maxRedirects) {
				throw new FetchError(FETCH_KINDS.redirects, `Too many redirects (>${maxRedirects})`);
			}

			try {
				currentUrl = new URL(location, currentUrl);
			} catch {
				throw new FetchError(
					FETCH_KINDS.redirectLocation,
					`Invalid redirect location: ${location}`,
				);
			}
		}

		if (!response.ok) {
			await discardBody(response);

			// Wall statuses
			if (response.status === 402 || response.status === 403 || response.status === 429) {
				throw new FetchError(
					FETCH_KINDS.blocked,
					`Blocked by the site (HTTP ${response.status})`,
				);
			}

			throw new FetchError(
				FETCH_KINDS.http,
				`Failed to fetch URL: HTTP ${response.status}` +
					`${response.statusText ? ` ${response.statusText}` : ""}`,
			);
		}

		const contentType = header(response.headers, "content-type") ?? "";

		if (!isSupportedContentType(contentType)) {
			await discardBody(response);
			throw new FetchError(
				FETCH_KINDS.contentType,
				`Unsupported content type: ${contentType.trim() || "unknown"}`,
			);
		}

		const body = decodeCharset(await readResponseBody(response, maxBytes), contentType);
		const challenged = header(response.headers, "cf-mitigated")?.toLowerCase() === "challenge";
		if (challenged || isChallengePage(body, undefined, contentType)) {
			throw new FetchError(FETCH_KINDS.blocked, "Blocked by a security challenge page");
		}

		const extracted = extractByContentType(contentType, body);
		if (!extracted.text) {
			throw new FetchError(FETCH_KINDS.empty, EMPTY_MESSAGE);
		}

		if (isChallengePage(extracted.text, extracted.title, contentType)) {
			throw new FetchError(FETCH_KINDS.blocked, "Blocked by a security challenge page");
		}

		const totalChars = extracted.text.length;
		const cut = truncateParagraphs(extracted.text, maxChars);
		const availableChars = input.fullText
			? cut.text.replace(/\n\n\[Content truncated[^\]]*\]\s*$/, "").length
			: totalChars;
		const capped = totalChars > maxChars;
		const notes = [
			...(capped ? [`Content capped at ${maxChars} chars`] : []),
			...softPageNotes(extracted.text, totalChars, contentType),
		];

		return {
			url: input.url.trim(),
			finalUrl: currentUrl.toString(),
			status: response.status,
			...(contentType ? { contentType } : {}),
			...(extracted.title ? { title: extracted.title } : {}),
			...(extracted.description ? { description: extracted.description } : {}),
			text: cut.text,
			truncated: cut.truncated,
			totalChars: availableChars,
			...(notes.length ? { note: notes.join("; ") } : {}),
			fetchedAt: Date.now(),
		};
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw input.signal?.aborted
				? new FetchError(FETCH_KINDS.cancelled, "Cancelled")
				: new FetchError(FETCH_KINDS.timeout, `Timed out after ${timeoutMs} ms`);
		}

		if (browserFallback && !input.signal?.aborted && shouldRender(error)) {
			try {
				return await renderPage(input, currentUrl, maxChars, timeoutMs, maxBytes);
			} catch (browserError) {
				if (
					browserError instanceof FetchError &&
					(browserError.kind === FETCH_KINDS.cancelled ||
						browserError.kind === FETCH_KINDS.tooLarge)
				) {
					throw browserError;
				}
			}
		}

		throw error;
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", onAbort);
	}
}
