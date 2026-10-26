import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import latestVersion from "./latest-version.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.GAMA_PACKAGE_NAME;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): string[] {
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		return handler(url, init);
	}) as typeof fetch;
	return calls;
}

function registryResponse(version: unknown): Response {
	return Response.json({ version });
}

describe("latest-version endpoint", () => {
	it("returns the latest release for the default package", async () => {
		const calls = stubFetch(async () => registryResponse("1.2.3"));

		const response = await latestVersion(new Request("https://gama.example/api/latest-version"));

		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			version: "1.2.3",
			packageName: "@huranth/gama-harness",
			url: "https://www.npmjs.com/package/@huranth/gama-harness",
		});
		assert.deepEqual(calls, ["https://registry.npmjs.org/%40huranth%2Fgama-harness/latest"]);
	});

	it("allows overriding the package name", async () => {
		process.env.GAMA_PACKAGE_NAME = "@scope/gama";
		const calls = stubFetch(async () => registryResponse("2.0.0"));

		const response = await latestVersion(new Request("https://gama.example/api/latest-version"));

		assert.equal(response.status, 200);
		assert.deepEqual(calls, ["https://registry.npmjs.org/%40scope%2Fgama/latest"]);
		assert.equal(((await response.json()) as { packageName: string }).packageName, "@scope/gama");
	});

	it("answers HEAD without a body", async () => {
		stubFetch(async () => registryResponse("1.2.3"));

		const response = await latestVersion(
			new Request("https://gama.example/api/latest-version", { method: "HEAD" }),
		);

		assert.equal(response.status, 200);
		assert.equal(await response.text(), "");
	});

	it("rejects unsupported methods", async () => {
		const response = await latestVersion(
			new Request("https://gama.example/api/latest-version", { method: "POST" }),
		);

		assert.equal(response.status, 405);
	});

	it("reports an unavailable registry", async () => {
		stubFetch(async () => new Response("nope", { status: 500 }));

		const response = await latestVersion(new Request("https://gama.example/api/latest-version"));

		assert.equal(response.status, 503);
		assert.equal(response.headers.get("cache-control"), "no-store");
	});

	it("reports a registry that cannot be reached", async () => {
		stubFetch(async () => {
			throw new Error("timeout");
		});

		const response = await latestVersion(new Request("https://gama.example/api/latest-version"));

		assert.equal(response.status, 503);
	});

	it("rejects an invalid version payload", async () => {
		stubFetch(async () => registryResponse("latest"));

		const response = await latestVersion(new Request("https://gama.example/api/latest-version"));

		assert.equal(response.status, 503);
	});

	it("rejects a prerelease version", async () => {
		stubFetch(async () => registryResponse("1.2.3-beta.1"));

		const response = await latestVersion(new Request("https://gama.example/api/latest-version"));

		assert.equal(response.status, 503);
	});

	it("rejects a payload that is not JSON", async () => {
		stubFetch(async () => new Response("not json", { status: 200 }));

		const response = await latestVersion(new Request("https://gama.example/api/latest-version"));

		assert.equal(response.status, 503);
	});
});
