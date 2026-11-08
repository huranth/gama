import http from "node:http";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "../src/core/tools/web/get.ts";
import {
	FetchError,
	FETCH_KINDS,
	readUrl,
	type FetchLike,
} from "../src/core/tools/web/read-url.ts";
import { SsrfError } from "../src/core/tools/web/security/ssrf.ts";

const html = `<!doctype html>
<html>
<head>
	<title>Example docs</title>
	<meta name="description" content="A short guide">
</head>
<body>
	<nav>Navigation links</nav>
	<article>
		<h1>Getting started</h1>
		<p>See <a href="https://example.com/next">the next page</a> for details.</p>
		<pre><code class="language-js">const value = 42;</code></pre>
		<script>alert("nope")</script>
	</article>
	<footer>Footer text</footer>
</body>
</html>`;

function respond(body: string | Uint8Array, contentType: string, status = 200): FetchLike {
	return async () => new Response(body, { status, headers: { "content-type": contentType } });
}

describe("fetchPage", () => {
	it("runs the full extraction pipeline for text/html", async () => {
		const page = await fetchPage({
			url: "https://example.com/docs",
			fetchImpl: respond(html, "text/html; charset=utf-8"),
		});

		expect(page.finalUrl).toBe("https://example.com/docs");
		expect(page.status).toBe(200);
		expect(page.title).toBe("Example docs");
		expect(page.description).toBe("A short guide");
		expect(page.text).toContain("Getting started");
		expect(page.text).toContain("[the next page](https://example.com/next)");
		expect(page.text).toContain("```js");
		expect(page.text).toContain("const value = 42;");
		expect(page.text).not.toContain("Navigation links");
		expect(page.text).not.toContain("Footer text");
		expect(page.text).not.toContain("nope");
		expect(page.truncated).toBe(false);
		expect(typeof page.fetchedAt).toBe("number");
	});

	it("rejects a Cloudflare challenge instead of treating it as content", async () => {
		const challenge = `<!doctype html>
<html>
<head><title>Just a moment...</title></head>
<body>
	<h1>stackoverflow.com</h1>
	<p>Performing security verification</p>
	<p>This website uses a security service to protect against malicious bots.</p>
</body>
</html>`;

		const error = await fetchPage({
			url: "https://example.com/challenge",
			fetchImpl: respond(challenge, "text/html"),
			browserFallback: false,
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(FetchError);
		expect((error as FetchError).kind).toBe(FETCH_KINDS.blocked);
		expect((error as FetchError).message).toContain("challenge");
	});

	it("rejects a Reddit humanity wall", async () => {
		const wall = `<!doctype html>
<html>
<head><title>Reddit - Please wait for verification</title></head>
<body>
	<h1>Prove your humanity</h1>
	<p>Complete the action below to continue.</p>
</body>
</html>`;

		const error = await fetchPage({
			url: "https://example.com/reddit-wall",
			fetchImpl: respond(wall, "text/html"),
			browserFallback: false,
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(FetchError);
		expect((error as FetchError).kind).toBe(FETCH_KINDS.blocked);
	});

	it("rejects a cf-mitigated challenge header", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response("<html><title>Reddit</title><body>normal looking</body></html>", {
				status: 200,
				headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
			});

		const error = await fetchPage({
			url: "https://example.com/cf-header",
			fetchImpl,
			browserFallback: false,
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(FetchError);
		expect((error as FetchError).kind).toBe(FETCH_KINDS.blocked);
	});

	it("rejects an empty challenge page from its title", async () => {
		const body = `<html><head><title>Just a moment...</title></head><body></body></html>`;

		const error = await fetchPage({
			url: "https://example.com/empty-challenge",
			fetchImpl: respond(body, "text/html"),
			browserFallback: false,
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(FetchError);
		expect((error as FetchError).kind).toBe(FETCH_KINDS.blocked);
	});

	it("does not block a long page only because its title says security check", async () => {
		const body =
			`<html><head><title>Security check</title></head><body><article><p>` +
			`${"safe text ".repeat(1_500)}</p></article></body></html>`;

		const page = await fetchPage({
			url: "https://example.com/security-doc",
			fetchImpl: respond(body, "text/html"),
			browserFallback: false,
		});

		expect(page.text).toContain("safe text");
	});

	it("rejects a redirect that carries credentials", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://user:pass@example.com/next" },
			});

		await expect(fetchPage({ url: "https://example.com/start", fetchImpl })).rejects.toThrow(
			"URLs with credentials are not supported",
		);
	});

	it("keeps full text past 200k within the 2 MB body cap", async () => {
		const body = "word ".repeat(380_000);
		const page = await fetchPage({
			url: "https://example.com/huge.txt",
			fullText: true,
			fetchImpl: respond(body, "text/plain"),
		});

		expect(page.text.length).toBeGreaterThan(200_000);
		expect(page.text).not.toContain("[Content truncated]");
		expect(page.totalChars).toBe(page.text.length);
	});

	it("flags a suspiciously short page instead of trusting it", async () => {
		const body = `<html><head><title>NOWSECURE</title></head>
<body><h1>NOWSECURE</h1><p>by nodriver</p></body></html>`;

		const page = await fetchPage({
			url: "https://example.com/short",
			fetchImpl: respond(body, "text/html"),
			browserFallback: false,
		});

		expect(page.note).toContain("Short page");
		expect(page.note).toContain("verify this is not a block");
	});

	it("flags a consent page without mistaking it for content", async () => {
		const body = `<html><head><title>Before you continue</title></head>
<body><p>${"Before you continue to the site. ".repeat(20)}</p></body></html>`;

		const page = await fetchPage({
			url: "https://example.com/consent",
			fetchImpl: respond(body, "text/html"),
			browserFallback: false,
		});

		expect(page.note).toContain("consent or interstitial wall");
	});

	it("trims padded URLs and requests compressed responses", async () => {
		const requested: string[] = [];
		const encodings: Array<string | null> = [];
		const fetchImpl: FetchLike = async (input, init) => {
			requested.push(String(input));
			encodings.push(new Headers(init?.headers).get("accept-encoding"));
			return new Response("ok", { headers: { "content-type": "text/plain" } });
		};

		const urlPage = await readUrl({
			url: "  https://example.com/pad  ",
			fetch: fetchImpl,
		});
		const page = await fetchPage({
			url: "  https://example.com/pad  ",
			fetchImpl,
		});

		expect(urlPage.url).toBe("https://example.com/pad");
		expect(page.url).toBe("https://example.com/pad");
		expect(requested).toEqual(["https://example.com/pad", "https://example.com/pad"]);
		expect(encodings).toEqual(["gzip, deflate, br", "gzip, deflate, br"]);
	});

	it("rejects a response without a content type", async () => {
		const fetchImpl: FetchLike = async () => new Response(new Uint8Array([111, 107]));

		const pageError = await fetchPage({
			url: "https://example.com/no-type",
			fetchImpl,
		}).catch((error) => error);
		const urlError = await readUrl({
			url: "https://example.com/no-type",
			fetch: fetchImpl,
		}).catch((error) => error);

		expect(pageError).toBeInstanceOf(FetchError);
		expect(urlError).toBeInstanceOf(FetchError);
		expect((pageError as FetchError).kind).toBe(FETCH_KINDS.contentType);
		expect((urlError as FetchError).kind).toBe(FETCH_KINDS.contentType);
	});

	it("extracts XML and RSS bodies as text in both paths", async () => {
		const body = "<rss><channel><title>Feed</title><item>hello</item></channel></rss>";
		const fetchImpl = respond(body, "application/rss+xml");

		const page = await fetchPage({ url: "https://example.com/feed.xml", fetchImpl });
		const urlPage = await readUrl({ url: "https://example.com/feed.xml", fetch: fetchImpl });

		expect(page.text).toContain("hello");
		expect(urlPage.text).toContain("hello");
	});

	it("resolves redirect chains and records the final URL", async () => {
		const requested: string[] = [];
		const fetchImpl: FetchLike = async (input) => {
			const url = String(input);
			requested.push(url);
			if (url === "https://example.com/start") {
				return new Response(null, {
					status: 302,
					headers: { location: "/next" },
				});
			}
			return new Response(html, { headers: { "content-type": "text/html" } });
		};

		const page = await fetchPage({ url: "https://example.com/start", fetchImpl });

		expect(page.finalUrl).toBe("https://example.com/next");
		expect(requested).toEqual(["https://example.com/start", "https://example.com/next"]);
	});

	it("light-normalizes text/plain", async () => {
		const page = await fetchPage({
			url: "https://example.com/notes.txt",
			fetchImpl: respond("line  one\n\n\nline   two\n", "text/plain"),
		});

		expect(page.title).toBeUndefined();
		expect(page.text).toContain("line one");
		expect(page.text).toContain("line two");
		expect(page.text).not.toContain("line  one");
		expect(page.truncated).toBe(false);
	});

	it("pretty-prints application/json", async () => {
		const page = await fetchPage({
			url: "https://example.com/data.json",
			fetchImpl: respond('{"b":1,"a":[1,2]}', "application/json"),
		});

		expect(page.text).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}');
	});

	it("rejects unsupported content types before reading the body", async () => {
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				pulls++;
				throw new Error("body was read");
			},
		});
		const fetchImpl: FetchLike = async () =>
			new Response(stream, { headers: { "content-type": "image/png" } });

		await expect(fetchPage({ url: "https://example.com/image", fetchImpl })).rejects.toThrow(
			/Unsupported content type/,
		);
		expect(pulls).toBeLessThanOrEqual(1);
	});

	it("rejects oversized bodies from content-length without reading", async () => {
		let enqueued = 0;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				enqueued++;
				controller.enqueue(new Uint8Array(16));
			},
		});
		const fetchImpl: FetchLike = async () =>
			new Response(stream, {
				headers: { "content-type": "text/plain", "content-length": "1000" },
			});

		await expect(
			fetchPage({ url: "https://example.com/big", fetchImpl, maxBytes: 100 }),
		).rejects.toThrow(/Response is too large/);
		expect(enqueued).toBe(1);
	});

	it("stops reading a stream that runs past the byte cap", async () => {
		const chunk = new Uint8Array(100);
		const fetchImpl: FetchLike = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (let i = 0; i < 3; i++) controller.enqueue(chunk);
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/plain" } },
			);

		await expect(
			fetchPage({ url: "https://example.com/stream", fetchImpl, maxBytes: 150 }),
		).rejects.toThrow(/Response exceeded 150 bytes/);
	});

	it("decodes gzip-compressed fixture bodies", async () => {
		const gzipped = zlib.gzipSync(Buffer.from(html));
		const stream = new Response(gzipped).body!.pipeThrough(new DecompressionStream("gzip"));
		const fetchImpl: FetchLike = async () =>
			new Response(stream, {
				headers: { "content-type": "text/html", "content-encoding": "gzip" },
			});

		const page = await fetchPage({ url: "https://example.com/gzip", fetchImpl });

		expect(page.title).toBe("Example docs");
		expect(page.text).toContain("Getting started");
	});

	it("times out with the configured budget", async () => {
		const fetchImpl: FetchLike = (_url, init) =>
			new Promise((_, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});

		await expect(
			fetchPage({ url: "https://example.com/slow", fetchImpl, timeoutMs: 20 }),
		).rejects.toThrow("Timed out after 20 ms");
	});

	it("aborts mid-flight when the external signal fires", async () => {
		const controller = new AbortController();
		const fetchImpl: FetchLike = (_url, init) =>
			new Promise((_, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});

		const pending = fetchPage({
			url: "https://example.com/slow",
			fetchImpl,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 10);
		await expect(pending).rejects.toThrow("Cancelled");
	});

	it("truncates at a paragraph boundary", async () => {
		const paragraphs = Array.from(
			{ length: 10 },
			(_, i) => `Paragraph ${i} ` + `${"word ".repeat(40).trimEnd()}`,
		).join("\n\n");

		const page = await fetchPage({
			url: "https://example.com/long.txt",
			maxChars: 1000,
			fetchImpl: respond(paragraphs, "text/plain"),
		});

		const kept = page.text.replace(/\n\n\[Content truncated\]$/, "");
		expect(page.truncated).toBe(true);
		expect(kept.length).toBeLessThanOrEqual(1000);
		expect(kept.endsWith("word")).toBe(true);
		expect(page.text.endsWith("[Content truncated]")).toBe(true);
	});

	it("refuses a redirect hop into a private address", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/secret" },
			});
		};

		await expect(fetchPage({ url: "https://example.com/hop", fetchImpl })).rejects.toThrow(
			/Blocked address/,
		);
		expect(calls).toBe(1);
	});

	it("stops after the redirect budget", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return new Response(null, { status: 302, headers: { location: "/loop" } });
		};

		await expect(fetchPage({ url: "https://example.com/loop", fetchImpl })).rejects.toThrow(
			/Too many redirects \(>5\)/,
		);
		expect(calls).toBe(6);
	});

	it("treats a redirect without a location as final", async () => {
		const fetchImpl: FetchLike = async () => new Response(null, { status: 302 });

		await expect(fetchPage({ url: "https://example.com/none", fetchImpl })).rejects.toThrow(
			/302/,
		);
	});

	it("refuses non-http schemes", async () => {
		await expect(
			fetchPage({ url: "ftp://example.com/file", fetchImpl: respond("x", "text/plain") }),
		).rejects.toThrow("Only http:// and https:// URLs are supported");
	});

	it("truncates to maxChars", async () => {
		const page = await fetchPage({
			url: "https://example.com/long.txt",
			maxChars: 1000,
			fetchImpl: respond("word ".repeat(500), "text/plain"),
		});

		expect(page.truncated).toBe(true);
		expect(page.text.length).toBeLessThanOrEqual(1100);
		expect(page.text.endsWith("[Content truncated]")).toBe(true);
	});

	it("keeps the full document length when the visible slice is capped", async () => {
		const fullText = "word ".repeat(500);
		const page = await fetchPage({
			url: "https://example.com/long.txt",
			maxChars: 1000,
			fetchImpl: respond(fullText, "text/plain"),
		});

		expect(page.truncated).toBe(true);
		expect(page.totalChars).toBe(fullText.trim().length);
		expect(page.totalChars).toBeGreaterThan(1000);
	});

	it("rejects private IP literals before fetching", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return new Response("ok", { headers: { "content-type": "text/plain" } });
		};

		await expect(fetchPage({ url: "http://127.0.0.1/secret", fetchImpl })).rejects.toThrow(
			/Blocked address/,
		);
		expect(calls).toBe(0);
	});

	it("throws on HTTP error statuses", async () => {
		await expect(
			fetchPage({
				url: "https://example.com/missing",
				fetchImpl: respond("gone", "text/html", 404),
			}),
		).rejects.toThrow(/404/);
	});

	it("reports a 403 as blocked without an external reader", async () => {
		const requested: string[] = [];
		const fetchImpl: FetchLike = async (input) => {
			requested.push(String(input));
			return new Response(null, { status: 403, statusText: "Forbidden" });
		};

		const error = await fetchPage({
			url: "https://example.com/walled",
			fetchImpl,
		}).catch((reason) => reason);

		expect(error).toBeInstanceOf(FetchError);
		expect((error as FetchError).kind).toBe(FETCH_KINDS.blocked);
		expect((error as Error).message).toContain("403");
		expect(requested).toEqual(["https://example.com/walled"]);
	});

	it("does not treat a long article mentioning JavaScript as a wall", async () => {
		let calls = 0;
		const filler = "Safe body text. ".repeat(200);
		const fetchImpl: FetchLike = async () => {
			calls += 1;
			return new Response(`<article><p>${filler}How to enable JavaScript.</p></article>`, {
				headers: { "content-type": "text/html" },
			});
		};

		const page = await fetchPage({
			url: "https://example.com/article",
			fetchImpl,
		});

		expect(calls).toBe(1);
		expect(page.text).toContain("How to enable JavaScript");
	});

	it("does not apply the wall check to text/plain", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls += 1;
			return new Response("captcha wall", { headers: { "content-type": "text/plain" } });
		};

		const page = await fetchPage({
			url: "https://example.com/notes.txt",
			fetchImpl,
		});

		expect(calls).toBe(1);
		expect(page.text).toBe("captcha wall");
	});

	it("reports a 429 as blocked", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response(null, { status: 429, statusText: "Too Many Requests" });

		const error = await fetchPage({
			url: "https://example.com/busy",
			fetchImpl,
		}).catch((reason) => reason);

		expect(error).toBeInstanceOf(FetchError);
		expect((error as FetchError).kind).toBe(FETCH_KINDS.blocked);
		expect((error as Error).message).toContain("429");
	});

	it("makes one request for a blocked page", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return new Response(null, { status: 403, statusText: "Forbidden" });
		};

		await expect(fetchPage({ url: "https://example.com/walled", fetchImpl })).rejects.toThrow(
			/403/,
		);
		expect(calls).toBe(1);
	});

	it("does not retry a permanent 404", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return new Response(null, { status: 404, statusText: "Not Found" });
		};

		await expect(fetchPage({ url: "https://example.com/missing", fetchImpl })).rejects.toThrow(
			/404/,
		);
		expect(calls).toBe(1);
	});

	it("does not retry a 403", async () => {
		const requested: string[] = [];
		const fetchImpl: FetchLike = async (input) => {
			requested.push(String(input));
			return new Response(null, { status: 403, statusText: "Forbidden" });
		};

		await expect(fetchPage({ url: "https://example.com/walled", fetchImpl })).rejects.toThrow(
			/403/,
		);
		expect(requested).toHaveLength(1);
	});

	it("aborts when the signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			fetchPage({ url: "https://example.com/", signal: controller.signal }),
		).rejects.toThrow("Cancelled");
	});
});

// Edge scenarios
describe("fetchPage edge cases", () => {
	it("rejects invalid urls", async () => {
		await expect(
			fetchPage({ url: "not a url", fetchImpl: respond("x", "text/plain") }),
		).rejects.toThrow("Invalid URL");
	});

	it("rejects urls with embedded credentials", async () => {
		await expect(
			fetchPage({
				url: "https://user:pass@example.com/private",
				fetchImpl: respond("x", "text/plain"),
			}),
		).rejects.toThrow("URLs with credentials are not supported");
	});

	it("trims surrounding whitespace from the url", async () => {
		const page = await fetchPage({
			url: "  https://example.com/trim  ",
			fetchImpl: respond("trim ok", "text/plain"),
		});

		expect(page.url).toBe("https://example.com/trim");
	});

	it("rejects a response with no content type", async () => {
		const fetchImpl: FetchLike = async () => new Response(new TextEncoder().encode("raw bytes"));

		await expect(fetchPage({ url: "https://example.com/raw", fetchImpl })).rejects.toThrow(
			"Unsupported content type: unknown",
		);
	});

	it("keeps malformed json as plain text", async () => {
		const page = await fetchPage({
			url: "https://example.com/broken.json",
			fetchImpl: respond("{not json", "application/json"),
		});

		expect(page.text).toBe("{not json");
	});

	it("treats linked-data json as json", async () => {
		const page = await fetchPage({
			url: "https://example.com/ld",
			fetchImpl: respond('{"@context":"https://schema.org"}', "application/ld+json"),
		});

		expect(page.text).toContain('"@context"');
	});

	it("rejects a page with no readable text", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response("<html><head><title>T</title></head><body></body></html>", {
				headers: { "content-type": "text/html" },
			});

		await expect(fetchPage({ url: "https://example.com/empty", fetchImpl })).rejects.toThrow(
			"No text",
		);
	});

	it("clamps a tiny maxChars up to the floor", async () => {
		const page = await fetchPage({
			url: "https://example.com/clamped",
			maxChars: 10,
			fetchImpl: respond("word ".repeat(400), "text/plain"),
		});

		expect(page.truncated).toBe(true);
		expect(page.text.length).toBeLessThanOrEqual(1100);
	});

	it("caps an oversized maxChars at the ceiling", async () => {
		const page = await fetchPage({
			url: "https://example.com/ceiling",
			maxChars: 100_000,
			fetchImpl: respond("x".repeat(60_000), "text/plain"),
		});

		expect(page.truncated).toBe(true);
		expect(page.text.length).toBeLessThan(60_000);
	});

	it("honors a smaller redirect budget", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return new Response(null, { status: 302, headers: { location: "/next" } });
		};

		await expect(
			fetchPage({ url: "https://example.com/hop", fetchImpl, maxRedirects: 2 }),
		).rejects.toThrow("Too many redirects (>2)");
		expect(calls).toBe(3);
	});

	it("rejects a malformed redirect location", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response(null, { status: 302, headers: { location: "http://" } });

		await expect(fetchPage({ url: "https://example.com/bad", fetchImpl })).rejects.toThrow(
			"Invalid redirect location: http://",
		);
	});

	it("reports a 402 as blocked", async () => {
		const fetchImpl: FetchLike = async () =>
			new Response(null, { status: 402, statusText: "Payment Required" });

		const error = await fetchPage({
			url: "https://example.com/paywalled",
			fetchImpl,
		}).catch((reason) => reason);

		expect(error).toBeInstanceOf(FetchError);
		expect((error as FetchError).kind).toBe(FETCH_KINDS.blocked);
		expect((error as Error).message).toContain("402");
	});

	it("keeps cjk text through extraction and truncation", async () => {
		const cjk =
			"汉字与英文混合的内容，用于验证截断。" +
			"更多汉字内容，继续追加。".repeat(160);
		const page = await fetchPage({
			url: "https://example.com/cjk",
			maxChars: 1000,
			fetchImpl: respond(cjk, "text/plain; charset=utf-8"),
		});

		expect(page.text).toContain("汉字与英文混合的内容");
		expect(page.truncated).toBe(true);
		expect(page.text).toContain("[Content truncated]");
	});
});

// Parsing scenarios
describe("ported parsing scenarios", () => {
	it("decodes entity soup across named and numeric forms", async () => {
		const page = await fetchPage({
			url: "https://example.com/entities",
			fetchImpl: respond(
				`<main><p>Tom &amp; Jerry &quot;quoted&quot; &#39;apos&#39; &#x27;x&#x27; &middot; &hellip;</` +
					`p></main>`,
				"text/html",
			),
		});

		expect(page.text).toContain('Tom & Jerry "quoted"');
		expect(page.text).toContain("'apos'");
		expect(page.text).toContain("'x'");
		expect(page.text).toContain("* ...");
	});

	it("replaces out-of-range numeric HTML entities with U+FFFD", async () => {
		// Invalid references
		const page = await fetchPage({
			url: "https://example.com/bad-entity",
			fetchImpl: respond("<main><p>Bad entity: &#9999999999;</p></main>", "text/html"),
		});

		expect(page.text).toContain("Bad entity: \uFFFD");
	});

	it("prefers the article over a larger link-heavy main", async () => {
		const files = Array.from({ length: 40 }, (_, index) => `<a>file-${index}.ts</a>`).join("");
		const repoPage = `<html>
			<head><title>Repository Page</title></head>
			<body>
				<main>
					<section><h2>Folders and files</h2>${files}</section>
					<article class="markdown-body">
						<h1>Project README</h1>
						<p>This is the source content the researcher needs.</p>
					</article>
				</main>
			</body>
		</html>`;

		const page = await fetchPage({
			url: "https://example.com/repo",
			fetchImpl: respond(repoPage, "text/html"),
		});

		expect(page.text).toContain("Project README");
		expect(page.text).toContain("source content");
		expect(page.text).not.toContain("Folders and files");
		expect(page.text).not.toContain("file-39.ts");
	});

	it("does not add spaces between syntax-highlighted code tokens", async () => {
		const page = await fetchPage({
			url: "https://example.com/highlighted",
			fetchImpl: respond(
				`<main><pre><span>const</span> <span>answer</span><span>=</span><span>42</span><span>;</span>` +
					`</pre></main>`,
				"text/html",
			),
		});

		expect(page.text).toContain("const answer=42;");
	});

	it("decodes latin-1 bodies via the meta charset", async () => {
		const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x62, 0x61, 0x72]);
		const page = await fetchPage({
			url: "https://example.com/latin",
			fetchImpl: respond(
				new Uint8Array([
					...new TextEncoder().encode(`<html><head><meta charset="iso-8859-1"></head><body>`),
					...latin1,
					...new TextEncoder().encode("</body></html>"),
				]),
				"text/html",
			),
		});

		expect(page.text).toContain("café bar");
	});

	it("extracts markdown frontmatter into metadata and omits it from text", async () => {
		const markdown = [
			"---",
			'title: "Readable Docs"',
			"description: 'A useful docs page'",
			"---",
			"# First Heading",
			"Body with &middot; entity.",
		].join("\n");

		const page = await fetchPage({
			url: "https://example.com/docs.md",
			fetchImpl: respond(markdown, "text/markdown; charset=utf-8"),
		});

		expect(page.title).toBe("Readable Docs");
		expect(page.description).toBe("A useful docs page");
		expect(page.text.startsWith("# First Heading")).toBe(true);
		expect(page.text).toContain("Body with * entity.");
		expect(page.text).not.toContain("title:");
	});

	it("supports CRLF markdown frontmatter", async () => {
		const page = await fetchPage({
			url: "https://example.com/crlf.md",
			fetchImpl: respond("---\r\ntitle: CRLF Docs\r\n---\r\n# Body", "text/markdown"),
		});

		expect(page.title).toBe("CRLF Docs");
		expect(page.text).toBe("# Body");
	});
});

// Regression coverage
describe("fetchPage regressions", () => {
	it("reports blocked at the final redirect target", async () => {
		const requested: string[] = [];
		const fetchImpl: FetchLike = async (input) => {
			const url = String(input);
			requested.push(url);
			if (url === "https://example.com/start") {
				return new Response(null, { status: 302, headers: { location: "/walled" } });
			}
			return new Response(null, { status: 403, statusText: "Forbidden" });
		};

		await expect(fetchPage({ url: "https://example.com/start", fetchImpl })).rejects.toThrow(
			/Blocked by the site \(HTTP 403\)/,
		);

		expect(requested).toEqual(["https://example.com/start", "https://example.com/walled"]);
	});

	it("falls back to the meta charset when the header charset is unknown", async () => {
		const encode = new TextEncoder();
		const body = new Uint8Array([
			...encode.encode('<html><head><meta charset="iso-8859-1"></head><body>'),
			0x63,
			0x61,
			0x66,
			0xe9,
			...encode.encode("</body></html>"),
		]);
		const page = await fetchPage({
			url: "https://example.com/latin-unknown",
			fetchImpl: async () =>
				new Response(body, {
					headers: { "content-type": "text/html; charset=x-unknown-charset" },
				}),
		});

		expect(page.text).toContain("café");
	});

	it("still trusts a recognized header charset", async () => {
		const page = await fetchPage({
			url: "https://example.com/latin-header",
			fetchImpl: async () =>
				new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
					headers: { "content-type": "text/plain; charset=iso-8859-1" },
				}),
		});

		expect(page.text).toBe("café");
	});

	it("honors a zero redirect budget", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = async () => {
			calls++;
			return new Response(null, { status: 302, headers: { location: "/next" } });
		};

		await expect(
			fetchPage({ url: "https://example.com/nohop", fetchImpl, maxRedirects: 0 }),
		).rejects.toThrow("Too many redirects (>0)");
		expect(calls).toBe(1);
	});

	it("treats text/x-markdown as markdown", async () => {
		const page = await fetchPage({
			url: "https://example.com/notes.md",
			fetchImpl: respond("---\ntitle: X Notes\n---\nBody", "text/x-markdown"),
		});

		expect(page.title).toBe("X Notes");
		expect(page.text).toBe("Body");
	});

	it("readUrl discards the body of a failed response", async () => {
		let cancelled = false;
		const fetchImpl: FetchLike = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 500, headers: { "content-type": "text/plain" } },
			);

		await expect(readUrl({ url: "https://example.com/fail", fetch: fetchImpl })).rejects.toThrow(
			/500/,
		);
		expect(cancelled).toBe(true);
	});

	it("readUrl discards the body when the content type is unsupported", async () => {
		let cancelled = false;
		const fetchImpl: FetchLike = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 200, headers: { "content-type": "image/png" } },
			);

		await expect(readUrl({ url: "https://example.com/img", fetch: fetchImpl })).rejects.toThrow(
			/Unsupported content type/,
		);
		expect(cancelled).toBe(true);
	});
});

describe("readUrl against real sockets", () => {
	// No reply
	function hangingServer(): Promise<{ server: http.Server; port: number }> {
		return new Promise((resolve) => {
			const server = http.createServer(() => {});
			server.listen(0, "127.0.0.1", () => {
				const port = (server.address() as { port: number }).port;
				resolve({ server, port });
			});
		});
	}

	const local = (port: number) => `http://127.0.0.1:${port}/`;

	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts a hung connection at the 30s timeout", async () => {
		const { server, port } = await hangingServer();
		try {
			vi.useFakeTimers();
			const pending = readUrl({ url: local(port), isBlocked: () => false });
			const outcome = pending.then(
				() => null,
				(error) => error,
			);
			await vi.advanceTimersByTimeAsync(30_000);
			const error = await outcome;
			expect((error as Error).message).toBe("Timed out after 30000 ms");
		} finally {
			server.close();
		}
	});

	it("aborts mid-flight when the caller signal fires", async () => {
		const { server, port } = await hangingServer();
		try {
			const controller = new AbortController();
			const pending = readUrl({
				url: local(port),
				isBlocked: () => false,
				signal: controller.signal,
			});
			const outcome = pending.then(
				() => null,
				(error) => error,
			);
			setTimeout(() => controller.abort(), 25);
			const error = await outcome;
			expect((error as Error).message).toBe("Cancelled");
		} finally {
			server.close();
		}
	});
});

// Shared failures
describe("error taxonomy parity", () => {
	// Both paths
	async function bothErrors(url: string, transport: FetchLike): Promise<[unknown, unknown]> {
		const pageError = await fetchPage({ url, fetchImpl: transport }).then(
			() => null,
			(error) => error,
		);
		const urlError = await readUrl({ url, fetch: transport }).then(
			() => null,
			(error) => error,
		);
		return [pageError, urlError];
	}

	interface ParityCase {
		// Failure label
		name: string;
		url: string;
		fetch: FetchLike;
		kind: string;
		// Message
		message?: string;
	}

	const cases: ParityCase[] = [
		{
			name: "invalid url",
			url: "not a url",
			fetch: respond("x", "text/plain"),
			kind: FETCH_KINDS.invalidUrl,
			message: "Invalid URL",
		},
		{
			name: "unsupported scheme",
			url: "ftp://example.com/file",
			fetch: respond("x", "text/plain"),
			kind: FETCH_KINDS.scheme,
			message: "Only http:// and https:// URLs are supported",
		},
		{
			name: "http error",
			url: "https://example.com/missing",
			fetch: async () =>
				new Response("gone", {
					status: 404,
					statusText: "Not Found",
					headers: { "content-type": "text/html" },
				}),
			kind: FETCH_KINDS.http,
			message: "Failed to fetch URL: HTTP 404 Not Found",
		},
		{
			name: "unsupported content type",
			url: "https://example.com/image",
			fetch: respond("x", "image/png"),
			kind: FETCH_KINDS.contentType,
			message: "Unsupported content type: image/png",
		},
		{
			name: "too many redirects",
			url: "https://example.com/loop",
			fetch: async () => new Response(null, { status: 302, headers: { location: "/loop" } }),
			kind: FETCH_KINDS.redirects,
			message: "Too many redirects (>5)",
		},
		{
			name: "body too large",
			url: "https://example.com/big",
			fetch: async () =>
				new Response(new Uint8Array(8), {
					headers: { "content-type": "text/plain", "content-length": "3000000" },
				}),
			kind: FETCH_KINDS.tooLarge,
			message: "Response is too large (3000000 bytes); no partial body is returned",
		},
		{
			name: "empty page",
			url: "https://example.com/empty",
			fetch: async () =>
				new Response("<html></html>", {
					headers: { "content-type": "text/html" },
				}),
			kind: FETCH_KINDS.empty,
			message: "No text",
		},
	];

	for (const parityCase of cases) {
		it(`classifies ${parityCase.name} identically in both paths`, async () => {
			const [pageError, urlError] = await bothErrors(parityCase.url, parityCase.fetch);

			expect(pageError).toBeInstanceOf(FetchError);
			expect(urlError).toBeInstanceOf(FetchError);
			expect((pageError as FetchError).kind).toBe(parityCase.kind);
			expect((urlError as FetchError).kind).toBe(parityCase.kind);
			expect((urlError as Error).message).toBe((pageError as Error).message);
			if (parityCase.message) {
				expect((pageError as Error).message).toBe(parityCase.message);
			}
		});
	}

	it("classifies timeout identically in both paths", async () => {
		const aborts: FetchLike = () => Promise.reject(new DOMException("aborted", "AbortError"));

		const [pageError, urlError] = await bothErrors("https://example.com/slow", aborts);

		expect((pageError as FetchError).kind).toBe(FETCH_KINDS.timeout);
		expect((urlError as FetchError).kind).toBe(FETCH_KINDS.timeout);
		expect((urlError as Error).message).toBe((pageError as Error).message);
		expect((pageError as Error).message).toMatch(/^Timed out after \d+ ms$/);
	});

	it("classifies caller cancel identically in both paths", async () => {
		const controller = new AbortController();
		controller.abort();

		const pageError = await fetchPage({
			url: "https://example.com/x",
			signal: controller.signal,
			fetchImpl: respond("x", "text/plain"),
		}).then(
			() => null,
			(error) => error,
		);
		const urlError = await readUrl({
			url: "https://example.com/x",
			signal: controller.signal,
			fetch: respond("x", "text/plain"),
		}).then(
			() => null,
			(error) => error,
		);

		expect((pageError as FetchError).kind).toBe(FETCH_KINDS.cancelled);
		expect((urlError as FetchError).kind).toBe(FETCH_KINDS.cancelled);
		expect((urlError as Error).message).toBe((pageError as Error).message);
		expect((pageError as Error).message).toBe("Cancelled");
	});

	it("classifies ssrf refusal identically in both paths", async () => {
		const [pageError, urlError] = await bothErrors(
			"http://127.0.0.1/secret",
			respond("x", "text/plain"),
		);

		expect(pageError).toBeInstanceOf(SsrfError);
		expect(urlError).toBeInstanceOf(SsrfError);
		expect((urlError as Error).message).toBe((pageError as Error).message);
	});
});
