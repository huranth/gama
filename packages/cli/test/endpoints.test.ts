import { afterEach, describe, expect, it } from "vitest";
import { getServiceEndpoints, getUpdateCheckUrl } from "../src/core/endpoints.ts";

const originalUpdate = process.env.GAMA_UPDATE_URL;

afterEach(() => {
	if (originalUpdate === undefined) delete process.env.GAMA_UPDATE_URL;
	else process.env.GAMA_UPDATE_URL = originalUpdate;
});

describe("service endpoints", () => {
	it("uses the public update gateway", () => {
		delete process.env.GAMA_UPDATE_URL;

		expect(getUpdateCheckUrl()).toBe("https://gama-update.vercel.app/api/latest-version");
	});

	it("ignores an override without a protocol", () => {
		process.env.GAMA_UPDATE_URL = "gama-update.vercel.app/api/latest-version";

		expect(getUpdateCheckUrl()).toBe("https://gama-update.vercel.app/api/latest-version");
	});

	it("prefers an explicit override", () => {
		process.env.GAMA_UPDATE_URL = "https://updates.example.com/latest.json";

		expect(getUpdateCheckUrl()).toBe("https://updates.example.com/latest.json");
	});

	it("keeps every endpoint absolute", () => {
		for (const value of Object.values(getServiceEndpoints())) {
			expect(() => new URL(value)).not.toThrow();
		}
	});
});
