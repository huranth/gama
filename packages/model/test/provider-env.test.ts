import { afterEach, describe, expect, it } from "vitest";
import { getProviderEnvValue } from "../src/utils/provider-env.ts";
import { StringEnum } from "../src/utils/typebox-helpers.ts";

const NAME = "GAMA_TEST_PROVIDER_ENV";

afterEach(() => {
	delete process.env[NAME];
});

describe("getProviderEnvValue", () => {
	it("uses an explicit empty override", () => {
		process.env[NAME] = "outer";
		expect(getProviderEnvValue(NAME, { [NAME]: "" })).toBe("");
	});

	it("uses undefined to fall back", () => {
		process.env[NAME] = "outer";
		expect(getProviderEnvValue(NAME, {})).toBe("outer");
	});
});

describe("StringEnum", () => {
	it("keeps an empty default", () => {
		const schema = StringEnum(["", "value"] as const, { default: "" });
		expect((schema as { default?: string }).default).toBe("");
	});
});
