import { describe, expect, it } from "vitest";
import { getGamaUserAgent } from "../src/utils/gama-user-agent.ts";

describe("getGamaUserAgent", () => {
	it("formats the user agent expected by gama.dev", () => {
		const runtime = process.versions.bun
			? `bun/${process.versions.bun}`
			: `node/${process.version}`;
		const userAgent = getGamaUserAgent("1.2.3");

		expect(userAgent).toBe(`gama/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^gama\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
