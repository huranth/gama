import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fetchChangelogForVersion,
	findChangelogEntry,
	parseChangelogContent,
} from "../src/utils/changelog.ts";
import { allowNetwork } from "./test-network-env.ts";

const markdown = `# Changelog

## 1.1.1

- Update notice is one dim line.
- \`gama update\` prints an arrow.

## 1.1.0

- Added \`gama update\`.
`;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("changelog", () => {
	it("finds an entry by version, including pre-release versions", () => {
		const entries = parseChangelogContent(markdown);

		expect(findChangelogEntry(entries, "1.1.1")?.content).toContain("one dim line");
		expect(findChangelogEntry(entries, "1.1.1-test.1")?.content).toContain("one dim line");
		expect(findChangelogEntry(entries, "1.1.2")).toBeUndefined();
	});

	it("fetches release notes from the published package", async () => {
		const fetchMock = vi.fn(async () => new Response(markdown, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const notes = await fetchChangelogForVersion("@huranth/gama-harness", "1.1.1");

		expect(notes).toContain("one dim line");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://unpkg.com/@huranth/gama-harness@1.1.1/CHANGELOG.md",
			expect.anything(),
		);
	});

	it("falls back to the second host", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("missing", { status: 404 }))
			.mockResolvedValueOnce(new Response(markdown, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const notes = await fetchChangelogForVersion("@huranth/gama-harness", "1.1.1");

		expect(notes).toContain("one dim line");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"https://cdn.jsdelivr.net/npm/@huranth/gama-harness@1.1.1/CHANGELOG.md",
			expect.anything(),
		);
	});
});
