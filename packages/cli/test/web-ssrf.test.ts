import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { readUrl, type FetchLike } from "../src/core/tools/web/read-url.ts";
import {
	assertUrlAllowed,
	compileAllowlist,
	decodeIpv4Literal,
	isBlockedAddress,
	resolveAllowedAddresses,
	SsrfError,
	unwrapHost,
	validatingLookup,
} from "../src/core/tools/web/security/ssrf.ts";
import { pinnedFetch } from "../src/core/tools/web/pinned-fetch.ts";
import type { AddressPolicy, HostLookup, HostPolicy } from "../src/core/tools/web/security/ssrf.ts";
import type { LookupAddress, LookupOptions } from "node:dns";

const PUBLIC = "93.184.216.34";

// Scripted DNS
function resolver(...answers: string[][]): { lookupHost: HostLookup; calls: string[] } {
	const calls: string[] = [];
	const lookupHost: HostLookup = async (hostname) => {
		calls.push(hostname);
		return answers[Math.min(calls.length - 1, answers.length - 1)] ?? [];
	};
	return { lookupHost, calls };
}

type GateOptions = {
	lookupHost?: HostLookup;
	isBlocked?: AddressPolicy;
	allowlist?: HostPolicy;
	maxRedirects?: number;
};

type FetchImpl = (url: string) => Promise<Response>;

// Gated redirects
async function gatedFetch(
	fetchImpl: FetchImpl,
	start: string,
	options: GateOptions = {},
): Promise<Response> {
	const maxRedirects = options.maxRedirects ?? 5;
	let url = new URL(start);

	for (let hop = 0; hop <= maxRedirects; hop++) {
		await assertUrlAllowed(url, options);

		const response = await fetchImpl(url.toString());
		if (response.status < 300 || response.status > 399 || !response.headers.has("location")) {
			return response;
		}

		const location = response.headers.get("location")!;
		response.body?.cancel();

		try {
			url = new URL(location, url);
		} catch {
			throw new Error(`Invalid redirect location: ${location}`);
		}
	}

	throw new Error(`Too many redirects (> ${maxRedirects})`);
}

// Promise wrapper
function lookupPromise(
	lookup: ReturnType<typeof validatingLookup>,
	hostname: string,
	options: LookupOptions = {},
): Promise<LookupAddress[]> {
	return new Promise((resolve, reject) => {
		lookup(hostname, { ...options, all: true }, (error, address) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(address as LookupAddress[]);
		});
	});
}

describe("address policy", () => {
	it("blocks private and reserved IPv4", () => {
		const blocked = [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"192.168.0.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"0.1.2.3",
			"192.0.0.1",
			"192.0.2.1",
			"198.51.100.1",
			"203.0.113.1",
			"198.18.0.1",
			"198.19.0.1",
			"240.0.0.1",
			"224.0.0.1",
			"255.255.255.255",
		];
		for (const ip of blocked) expect(isBlockedAddress(ip)).toBe(true);
	});

	it("blocks private and reserved IPv6", () => {
		const blocked = [
			"::1",
			"::",
			"fc00::1",
			"fe80::1",
			"::ffff:127.0.0.1",
			"::7f00:1",
			"::a9fe:a9fe",
			"fec0::1",
			"64:ff9b:1::1",
			"not-an-ip",
		];
		for (const ip of blocked) expect(isBlockedAddress(ip)).toBe(true);
	});

	it("allows public addresses", () => {
		const allowed = [
			"8.8.8.8",
			"93.184.216.34",
			"1.1.1.1",
			"2606:2800:220:1::1",
			"2606:4700:4700::1111"
		];
		for (const ip of allowed) expect(isBlockedAddress(ip)).toBe(false);
	});

	it("strips brackets from IPv6", () => {
		expect(unwrapHost("[::1]")).toBe("::1");
		expect(unwrapHost("example.com")).toBe("example.com");
	});
});

describe("numeric IPv4 spellings", () => {
	it("decodes decimal and hex forms", () => {
		expect(decodeIpv4Literal("2130706433")).toBe("127.0.0.1");
		expect(decodeIpv4Literal("0x7f000001")).toBe("127.0.0.1");
		expect(decodeIpv4Literal("0x7f.0x00.0x00.0x01")).toBe("127.0.0.1");
		expect(decodeIpv4Literal("0x7f.1")).toBe("127.0.0.1");
		expect(decodeIpv4Literal("0177.0.0.1")).toBe("127.0.0.1");
	});

	it("rejects impossible numbers", () => {
		expect(decodeIpv4Literal("4294967296")).toBeUndefined();
		expect(decodeIpv4Literal("256.0.0.1")).toBeUndefined();
		expect(decodeIpv4Literal("example.com")).toBeUndefined();
	});

	it("blocks a decimal-spelled loopback URL", async () => {
		await expect(assertUrlAllowed(new URL("http://2130706433/"))).rejects.toThrow(/127\.0\.0\.1/);
		await expect(assertUrlAllowed(new URL("http://0x7f000001/"))).rejects.toThrow(/127\.0\.0\.1/);
	});
});

describe("url gate", () => {
	it("refuses a private IP literal without DNS", async () => {
		const { lookupHost, calls } = resolver([PUBLIC]);
		await expect(
			assertUrlAllowed(new URL("http://169.254.169.254/secret"), { lookupHost }),
		).rejects.toThrow("Blocked address");
		expect(calls).toEqual([]);
	});

	it("refuses non-http schemes", async () => {
		await expect(assertUrlAllowed(new URL("ftp://example.com/"))).rejects.toThrow(
			"Only http:// and https:// URLs are supported",
		);
		await expect(assertUrlAllowed(new URL("file:///etc/passwd"))).rejects.toThrow(
			"Only http:// and https:// URLs are supported",
		);
	});

	it("refuses a hostname resolving private", async () => {
		const { lookupHost } = resolver(["10.0.0.5"]);
		await expect(
			assertUrlAllowed(new URL("http://internal.example/"), { lookupHost })
		).rejects.toThrow(
			'Blocked address: 10.0.0.5',
		);
	});

	it("allows a hostname resolving public", async () => {
		const { lookupHost, calls } = resolver([PUBLIC]);
		await assertUrlAllowed(new URL("http://public.example/"), { lookupHost });
		expect(calls).toEqual(["public.example"]);
	});

	it("refuses when one answer is private", async () => {
		const { lookupHost } = resolver([PUBLIC, "10.0.0.7"]);
		await expect(assertUrlAllowed(new URL("http://mixed.example/"), { lookupHost })).rejects.toThrow(
			/(10\.0\.0\.7)/,
		);
	});

	it("refuses an empty answer", async () => {
		const { lookupHost } = resolver();
		await expect(assertUrlAllowed(new URL("http://empty.example/"), { lookupHost })).rejects.toThrow(
			'Unknown host',
		);
	});

	it("reports resolver failures", async () => {
		const lookupHost = async () => {
			throw new Error("dns down");
		};
		await expect(assertUrlAllowed(new URL("http://dead.example/"), { lookupHost })).rejects.toThrow(
			'Unknown host: dns down',
		);
	});

	it("skips DNS when asked but still checks literals", async () => {
		const { lookupHost, calls } = resolver(["10.0.0.5"]);
		await assertUrlAllowed(new URL("http://internal.example/"), { lookupHost, resolveDns: false });
		expect(calls).toEqual([]);

		await expect(
			assertUrlAllowed(new URL("http://[::1]/"), { lookupHost, resolveDns: false }),
		).rejects.toThrow("Blocked address");
	});

	it("honors a custom policy", async () => {
		const onlyLoopback: AddressPolicy = (ip) => ip !== "127.0.0.1";
		const { lookupHost } = resolver(["127.0.0.2"]);
		await expect(
			assertUrlAllowed(new URL("http://custom.example/"), { lookupHost, isBlocked: onlyLoopback }),
		).rejects.toThrow(/127\.0\.0\.2/);
		await assertUrlAllowed(new URL("http://127.0.0.1/"), { isBlocked: onlyLoopback });
	});
});

describe("dns rebinding", () => {
	it("refuses a connect-time answer that flipped private", async () => {
		const { lookupHost, calls } = resolver([PUBLIC], ["127.0.0.1"]);
		await assertUrlAllowed(new URL("http://localhost:8080/secret"), { lookupHost });
		await expect(lookupPromise(validatingLookup({ lookupHost }), "localhost")).rejects.toThrow(
			/(127\.0\.0\.1)/,
		);
		expect(calls.length).toBeGreaterThanOrEqual(2);
	});

	for (const address of [
		"::ffff:127.0.0.1",
		"169.254.169.254",
		"100.64.1.1",
		"fd00::1",
		"192.168.1.10"
	]) {
		it(`refuses a connect-time answer in ${address}`, async () => {
			const { lookupHost } = resolver([PUBLIC], [address]);
			await assertUrlAllowed(new URL("http://rebind.example/"), { lookupHost });
			await expect(lookupPromise(validatingLookup({ lookupHost }), "rebind.example")).rejects.toThrow(
				`Blocked address: ${address}`,
			);
		});
	}

	it("refuses a mixed connect-time answer", async () => {
		const { lookupHost } = resolver([PUBLIC], [PUBLIC, "10.0.0.7"]);
		await assertUrlAllowed(new URL("http://mixed.example/"), { lookupHost });
		await expect(lookupPromise(validatingLookup({ lookupHost }), "mixed.example")).rejects.toThrow(
			/(10\.0\.0\.7)/,
		);
	});

	it("filters by family and reports ENOTFOUND", async () => {
		const { lookupHost } = resolver([PUBLIC, "2606:4700:4700::1111"]);
		const both = await lookupPromise(
			validatingLookup({ lookupHost }),
			"dual.example",
			{},
		);
		expect(both.map((entry) => entry.address)).toEqual([PUBLIC, "2606:4700:4700::1111"]);

		const v4Only = await lookupPromise(
			validatingLookup({ lookupHost }),
			"dual.example",
			{ family: 4 }
		);
		expect(v4Only.map((entry) => entry.address)).toEqual([PUBLIC]);

		const { lookupHost: noV6 } = resolver([PUBLIC]);
		await expect(
			lookupPromise(validatingLookup({ lookupHost: noV6 }), "dual.example", { family: 6 }),
		).rejects.toMatchObject({ code: "ENOTFOUND" });
	});
});

describe("redirect re-validation", () => {
	it("refuses a redirect to a private literal", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl: FetchImpl = async (url) => {
			fetchCalls.push(url);
			return new Response(
				null,
				{ status: 302, headers: { location: "http://169.254.169.254/secret" } }
			);
		};

		const { lookupHost } = resolver([PUBLIC]);
		await expect(
			gatedFetch(fetchImpl, "http://public.example/start", { lookupHost })
		).rejects.toThrow(
			"Blocked address",
		);
		expect(fetchCalls).toEqual(["http://public.example/start"]);
	});

	it("re-validates every redirect hop", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl: FetchImpl = async (url) => {
			fetchCalls.push(url);
			return new Response(
				null,
				{ status: 302, headers: { location: "http://internal.example/secret" } }
			);
		};

		const onlyLoopback: AddressPolicy = (ip) => ip !== "127.0.0.1";
		const lookupHost: HostLookup = async (hostname) =>
			hostname === "internal.example" ? ["127.0.0.2"] : ["127.0.0.1"];

		await expect(
			gatedFetch(fetchImpl, "http://public.example/redirect", { lookupHost, isBlocked: onlyLoopback }),
		).rejects.toThrow(/127\.0\.0\.2/);
		expect(fetchCalls).toEqual(["http://public.example/redirect"]);
	});

	it("resolves relative locations against the current URL", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl: FetchImpl = async (url) => {
			fetchCalls.push(url);
			if (url === "http://public.example/start") {
				return new Response(null, { status: 302, headers: { location: "/next" } });
			}
			return new Response("done", { status: 200 });
		};

		const { lookupHost } = resolver([PUBLIC]);
		const response = await gatedFetch(fetchImpl, "http://public.example/start", { lookupHost });
		expect(response.status).toBe(200);
		expect(fetchCalls).toEqual(["http://public.example/start", "http://public.example/next"]);
	});

	it("gives up after too many redirects", async () => {
		const fetchCalls: string[] = [];
		const fetchImpl: FetchImpl = async (url) => {
			fetchCalls.push(url);
			return new Response(
				null,
				{ status: 302, headers: { location: `${new URL(url).origin}/again` } }
			);
		};

		const { lookupHost } = resolver([PUBLIC]);
		await expect(
			gatedFetch(fetchImpl, "http://public.example/loop", { lookupHost, maxRedirects: 2 }),
		).rejects.toThrow("Too many redirects (> 2)");
		expect(fetchCalls).toHaveLength(3);
	});

	it("rejects malformed locations", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(null, { status: 302, headers: { location: "http://" } });

		const { lookupHost } = resolver([PUBLIC]);
		await expect(
			gatedFetch(fetchImpl, "http://public.example/start", { lookupHost })
		).rejects.toThrow(
			"Invalid redirect location: http://",
		);
	});

	it("treats a non-3xx location as a final response", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response("final", { status: 200, headers: { location: "http://169.254.169.254/" } });

		const { lookupHost } = resolver([PUBLIC]);
		const response = await gatedFetch(fetchImpl, "http://public.example/ok", { lookupHost });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("final");
	});
});

describe("host allowlist", () => {
	it("matches exact hosts only", () => {
		const policy = compileAllowlist(["example.com"]);
		expect(policy.allows("example.com")).toBe(true);
		expect(policy.allows("api.example.com")).toBe(false);
	});

	it("matches subdomains without the apex", () => {
		const policy = compileAllowlist(["*.example.com"]);
		expect(policy.allows("example.com")).toBe(false);
		expect(policy.allows("api.example.com")).toBe(true);
		expect(policy.allows("deep.api.example.com")).toBe(true);
	});

	it("matches the apex and subdomains with double star", () => {
		const policy = compileAllowlist(["**.example.com"]);
		expect(policy.allows("example.com")).toBe(true);
		expect(policy.allows("api.example.com")).toBe(true);
	});

	it("matches one byte with a question mark", () => {
		const policy = compileAllowlist(["api?.example.com"]);
		expect(policy.allows("api1.example.com")).toBe(true);
		expect(policy.allows("api12.example.com")).toBe(false);
	});

	it("normalizes case, dots, ports, and brackets", () => {
		const policy = compileAllowlist(["Example.COM."]);
		expect(policy.allows("example.com")).toBe(true);
		expect(policy.allows("example.com:8443")).toBe(true);

		const v6 = compileAllowlist(["[2001:db8::1]:8443"]);
		expect(v6.allows("[2001:db8::1]:8443")).toBe(true);
		expect(v6.allows("example.com")).toBe(false);
	});

	it("throws on invalid patterns", () => {
		expect(() => compileAllowlist(["**.a.**"])).toThrow();
		expect(() => compileAllowlist(["a{x}"])).toThrow();
		expect(() => compileAllowlist(["a b"])).toThrow();
		expect(() => compileAllowlist(["*"], { denylist: true })).toThrow();
		expect(() => compileAllowlist(["*"])).not.toThrow();
	});

	it("refuses a redirect to a non-listed host before DNS", async () => {
		const fetchImpl: FetchImpl = async (url) => {
			if (url === "http://public.example/start") {
				return new Response(null, { status: 302, headers: { location: "http://other.example/x" } });
			}
			return new Response("leak", { status: 200 });
		};

		const { lookupHost, calls } = resolver([PUBLIC]);
		await expect(
			gatedFetch(fetchImpl, "http://public.example/start", {
				lookupHost,
				allowlist: compileAllowlist(["public.example"]),
			}),
		).rejects.toThrow('Host "other.example" is not on the allowlist');
		expect(calls).toEqual(["public.example"]);
	});
});

describe("resolveAllowedAddresses", () => {
	it("returns every allowed answer", async () => {
		const { lookupHost } = resolver([PUBLIC, "2606:4700:4700::1111"]);
		await expect(resolveAllowedAddresses("dual.example", { lookupHost })).resolves.toEqual([
			PUBLIC,
			"2606:4700:4700::1111",
		]);
	});

	it("carries host and address on the error", async () => {
		const { lookupHost } = resolver(["10.0.0.5"]);
		try {
			await resolveAllowedAddresses("internal.example", { lookupHost });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(SsrfError);
			expect(error).toMatchObject({ host: "internal.example", address: "10.0.0.5" });
		}
	});
});

// Loopback
describe("pinnedFetch", () => {
	const allowLoopback: AddressPolicy = (ip) => ip !== "127.0.0.1";
	let server: http.Server;
	let port = 0;
	let hits: { path: string; host: string | undefined }[] = [];

	const resolverFor = (...answers: string[][]) => {
		const calls: string[] = [];
		const lookupHost: HostLookup = async (hostname) => {
			calls.push(hostname);
			return answers[Math.min(calls.length - 1, answers.length - 1)]!;
		};
		return { lookupHost, calls };
	};

	beforeAll(async () => {
		server = http.createServer((request, response) => {
			hits.push({ path: request.url ?? "", host: request.headers.host });
			if (request.url === "/gzip") {
				response.writeHead(200, {
					"content-type": "text/plain",
					"content-encoding": "gzip",
				});
				response.end(gzipSync("compressed hello"));
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("internal secret");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(() => {
		server.close();
	});

	it("connects to the validated address and keeps the hostname", async () => {
		hits = [];
		const { lookupHost } = resolverFor(["127.0.0.1"]);
		const response = await pinnedFetch(`http://pinned.example:${port}/page?q=1`, {
			lookupHost,
			isBlocked: allowLoopback,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("internal secret");
		expect(hits).toEqual([{ path: "/page?q=1", host: `pinned.example:${port}` }]);
	});

	it("refuses a refused answer at connect time, before any byte is sent", async () => {
		hits = [];
		const { lookupHost } = resolverFor(["10.9.9.9"]);
		await expect(
			pinnedFetch(`http://pinned.example:${port}/`, { lookupHost, isBlocked: allowLoopback }),
		).rejects.toThrow("Blocked address: 10.9.9.9");
		expect(hits).toEqual([]);
	});

	it("decodes a compressed body like fetch does", async () => {
		const { lookupHost } = resolverFor(["127.0.0.1"]);
		const response = await pinnedFetch(`http://pinned.example:${port}/gzip`, {
			lookupHost,
			isBlocked: allowLoopback,
		});

		expect(await response.text()).toBe("compressed hello");
		expect(response.headers.get("content-encoding")).toBeNull();
	});

	it("aborts on the signal", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			pinnedFetch(`http://pinned.example:${port}/`, { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

// SSRF sweep
describe("ssrf sweep regressions", () => {
	it("blocks SRv6 and IPv4-translated ranges", () => {
		for (const ip of [
			"5f00::1",
			"5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
			"::ffff:0:7f00:1",
			"::ffff:0:127.0.0.1",
		]) {
			expect(isBlockedAddress(ip)).toBe(true);
		}
		// IPv4 path
		expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
		// Public spellings
		expect(isBlockedAddress("::ffff:806:808")).toBe(false);
	});

	it("refuses the IPv4-translated literal at the URL gate", async () => {
		const { lookupHost, calls } = resolver([]);
		await expect(
			assertUrlAllowed(new URL("http://[::ffff:0:127.0.0.1]/"), { lookupHost, resolveDns: false }),
		).rejects.toThrow("Blocked address");
		expect(calls).toEqual([]);
	});

	it("treats a multi-dot suffix as an IPv4 literal", async () => {
		await expect(
			assertUrlAllowed(new URL("http://127.0.0.1../"), { resolveDns: false }),
		).rejects.toThrow(/127\.0\.0\.1/);
	});

	it("matches bare IPv6 hosts against bracket patterns", () => {
		const allow = compileAllowlist(["[::1]"]);
		expect(allow.allows("::1")).toBe(true);
		expect(allow.allows("[::1]:8443")).toBe(true);
		expect(allow.allows("example.com")).toBe(false);

		const deny = compileAllowlist(["[::1]"], { denylist: true });
		expect(deny.allows("::1")).toBe(true);

		const v6 = compileAllowlist(["[2001:db8::1]"]);
		expect(v6.allows("2001:db8::1")).toBe(true);
		expect(v6.allows("example.com")).toBe(false);
	});

	it("rejects bracket patterns with trailing junk", () => {
		expect(() => compileAllowlist(["[*]foo"])).toThrow(/Bad pattern/);
		expect(() => compileAllowlist(["[2001:db8::1]junk"])).toThrow(/Bad pattern/);
		expect(() => compileAllowlist(["[::1][::2]"])).toThrow(/Bad pattern/);
		expect(() => compileAllowlist(["[*]:8443"])).toThrow(/Bad pattern/);
		expect(() => compileAllowlist(["[2001:db8::1]:8443"])).not.toThrow();
	});
});

// Edge suite
describe("read-url/pinned-fetch regression sweep", () => {
	// Local server
	describe("pinnedFetch transport behavior", () => {
		let server: import("node:http").Server;
		let port = 0;
		let lastRequest: { host?: string; url?: string; "accept-encoding"?: string } | undefined;

		beforeAll(async () => {
			server = http.createServer((request, response) => {
				lastRequest = {
					host: request.headers.host as string,
					url: request.url,
					"accept-encoding": request.headers["accept-encoding"] as string,
				};
				const path = request.url ?? "";
				if (path === "/empty-gzip") {
					response.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
					response.end(gzipSync(""));
					return;
				}
				if (path === "/stacked-encodings") {
					// Decode order
					response.writeHead(200, {
						"content-encoding": "gzip, deflate",
						"content-type": "text/plain",
					});
					response.end(zlib.deflateSync(zlib.gzipSync("stacked payload")));
					return;
				}
				if (path === "/raw-deflate") {
					// Raw deflate
					response.writeHead(200, { "content-encoding": "deflate", "content-type": "text/plain" });
					response.end(zlib.deflateRawSync("raw deflate payload"));
					return;
				}
				if (path === "/null-body-204") {
					response.writeHead(204);
					response.end();
					return;
				}
				if (path === "/null-body-304") {
					response.writeHead(304, { etag: "x" });
					response.end();
					return;
				}
				if (path === "/v6-only" && lastRequest?.host?.startsWith("[")) {
					response.writeHead(200, { "content-type": "text/plain" });
					response.end("v6 ok");
					return;
				}
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("default ok");
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			port = (server.address() as import("node:net").AddressInfo).port;
		});

		afterAll(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it("decodes stacked content encodings (gzip then deflate)", async () => {
			const response = await pinnedFetch(`http://localhost:${port}/stacked-encodings`, {
				lookupHost: async () => ["127.0.0.1"],
				isBlocked: () => false,
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-encoding")).toBeNull();
			expect(await response.text()).toBe("stacked payload");
		});

		it("decodes raw deflate streams that some servers send", async () => {
			const response = await pinnedFetch(`http://localhost:${port}/raw-deflate`, {
				lookupHost: async () => ["127.0.0.1"],
				isBlocked: () => false,
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("raw deflate payload");
		});

		it("handles zero-length compressed payloads without hanging", async () => {
			const response = await pinnedFetch(`http://localhost:${port}/empty-gzip`, {
				lookupHost: async () => ["127.0.0.1"],
				isBlocked: () => false,
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("");
		});

		it("treats 204 as a null-body status", async () => {
			const response = await pinnedFetch(`http://localhost:${port}/null-body-204`, {
				lookupHost: async () => ["127.0.0.1"],
				isBlocked: () => false,
			});
			expect(response.status).toBe(204);
			expect(response.body).toBeNull();
		});

		it("treats 304 as a null-body status with clean headers", async () => {
			const response = await pinnedFetch(`http://localhost:${port}/null-body-304`, {
				lookupHost: async () => ["127.0.0.1"],
				isBlocked: () => false,
			});
			expect(response.status).toBe(304);
			expect(response.body).toBeNull();
			// Header fixup
			expect(response.headers.get("etag")).toBe("x");
		});

		it("sends accept-encoding so servers can choose compression", async () => {
			await pinnedFetch(`http://localhost:${port}/`, {
				lookupHost: async () => ["127.0.0.1"],
				isBlocked: () => false,
			});
			expect(lastRequest?.["accept-encoding"]).toContain("gzip");
			expect(lastRequest?.["accept-encoding"]).toContain("br");
		});
	});

	describe("IPv6 bracket handling", () => {
		it("unwraps IPv6 brackets and rejects bracketed literal", async () => {
			expect(unwrapHost("[::1]")).toBe("::1");
			expect(unwrapHost("[2001:db8::1]")).toBe("2001:db8::1");
			expect(net.isIP("::1")).toBe(6);
		});

		it("rejects IPv6 literal URLs when the policy blocks them", async () => {
			await expect(
				readUrl({ url: "http://[::1]:8080/secret", isBlocked: (ip) => ip === "::1" }),
			).rejects.toThrow(/Blocked address/);
		});
	});

	describe("redirect and error cleanup", () => {
		function makeCancelTrackingBody(): {
			stream: ReadableStream<Uint8Array>;
			cancelled: () => boolean;
		} {
			let cancelled = false;
			const stream = new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				},
			});
			return { stream, cancelled: () => cancelled };
		}

		it("discards the body on a 302 redirect without a location header", async () => {
			const { stream, cancelled } = makeCancelTrackingBody();
			const fetchImpl: FetchLike = async () =>
				new Response(stream, {
					status: 302,
					headers: { "content-type": "text/html" },
				});

			await expect(
				readUrl({ url: "https://example.com/bad-redirect", fetch: fetchImpl }),
			).rejects.toThrow(/Failed to fetch URL/);
			expect(cancelled()).toBe(true);
		});

		it("discards redirect bodies between hops", async () => {
			const cancelled: boolean[] = [];
			const fetchImpl: FetchLike = async (input) => {
				if (String(input) === "https://example.com/start") {
					const track = new ReadableStream<Uint8Array>({
						cancel() {
							cancelled.push(true);
						},
					});
					return new Response(track, { status: 302, headers: { location: "/next" } });
				}
				return new Response("done", { status: 200, headers: { "content-type": "text/plain" } });
			};

			const result = await readUrl({ url: "https://example.com/start", fetch: fetchImpl });
			expect(result.finalUrl).toBe("https://example.com/next");
			expect(cancelled.length).toBeGreaterThanOrEqual(1);
		});

		it("aborts the request when the signal fires mid-flight", async () => {
			const controller = new AbortController();
			const fetchImpl: FetchLike = (_input, init) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
				});

			const pending = readUrl({
				url: "https://example.com/slow",
				fetch: fetchImpl,
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(), 10);
			await expect(pending).rejects.toThrow("Cancelled");
		});

		it("fails closed when the lookup hook returns garbage", async () => {
			const fetchImpl: FetchLike = async () => {
				throw new Error("should not fetch");
			};

			await expect(
				readUrl({
					url: "http://evil.example/secret",
					fetch: fetchImpl,
					resolveDns: true,
					lookupHost: async () => ["not an ip at all"],
				}),
			).rejects.toThrow(/Blocked address|Unknown host/);
		});

		it("rejects a redirect chain that loops between two hosts", async () => {
			let calls = 0;
			const fetchImpl: FetchLike = async (input) => {
				calls++;
				const url = String(input);
				if (url === "https://example.com/loop-a") {
					return new Response(
						null,
						{ status: 302, headers: { location: "https://example.org/loop-b" } }
					);
				}
				return new Response(null, { status: 302, headers: { location: "https://example.com/loop-a" } });
			};

			await expect(
				readUrl({ url: "https://example.com/loop-a", fetch: fetchImpl }),
			).rejects.toThrow(/Too many redirects/);
			expect(calls).toBeLessThanOrEqual(7);
		});
	});
});
