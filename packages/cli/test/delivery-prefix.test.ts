import { describe, expect, test } from "vitest";
import { parseDeliveryPrefix } from "../src/term/app.ts";

describe("delivery prefix", () => {
	test("leaves a plain prompt on steering", () => {
		expect(parseDeliveryPrefix("fix the bug")).toEqual({ text: "fix the bug" });
	});

	test("/s strips the prefix and steers", () => {
		expect(parseDeliveryPrefix("/s  fix the bug")).toEqual({
			text: "fix the bug",
			delivery: "steer",
		});
	});

	test("/q strips the prefix and queues", () => {
		expect(parseDeliveryPrefix("/Q fix the bug")).toEqual({
			text: "fix the bug",
			delivery: "followUp",
		});
	});

	test("bare /s makes steering the default", () => {
		expect(parseDeliveryPrefix("/s")).toEqual({ text: "", setDefault: "steer" });
	});

	test("bare /q makes queue the default", () => {
		expect(parseDeliveryPrefix("/q   ")).toEqual({ text: "", setDefault: "followUp" });
	});
});
