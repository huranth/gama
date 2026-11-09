import { describe, expect, test } from "vitest";
import { formatNotice } from "../src/core/notices.ts";

describe("formatNotice", () => {
	test("extracts the human message from a provider JSON body", () => {
		const notice = formatNotice(
			'Error: 400: {"type":"invalid_request_error","code":"COMPATIBILITY_ERROR","message":"unsupport' +
				'ed:reasoning_content"}',
		);

		expect(notice).toBe("Reasoning not supported");
	});

	test("maps a bare unsupported reasoning field", () => {
		expect(formatNotice("unsupported:reasoning_content")).toBe("Reasoning not supported");
		expect(formatNotice("unsupported: reasoning")).toBe("Reasoning not supported");
	});

	test("drops Windows paths and URLs", () => {
		const notice = formatNotice(
			"Failed to load models.json from C:\\Users\\ToLiMan\\AppData\\Roaming\\npm\\node_modules\\x\\R" +
				"EADME.md",
		);

		expect(notice).not.toContain("C:\\");
		expect(notice).not.toContain("README");

		const withUrl = formatNotice("Could not reach https://example.com/models today");
		expect(withUrl).not.toContain("http");
	});

	test("collapses multi-line messages to one line", () => {
		const notice = formatNotice("Could not read settings.\nCheck the file.\nMore detail.");

		expect(notice).toBe("Could not read settings");
		expect(notice).not.toContain("\n");
	});

	test("keeps a complete short first sentence", () => {
		expect(formatNotice("A bash command is already running. Press Esc to cancel it first")).toBe(
			"A bash command is already running",
		);
	});

	test("keeps the command in an actionable update warning", () => {
		const notice = formatNotice(
			"This installation is not writable. Run: npm install -g @huranth/gama-harness",
		);

		expect(notice).toContain("npm install -g @huranth/gama-harness");
	});

	test("keeps an already capitalized message", () => {
		expect(formatNotice("No models available")).toBe("No models available");
	});

	test("capitalizes a lowercase message", () => {
		expect(formatNotice("no models available")).toBe("No models available");
	});

	test("falls back for empty input", () => {
		expect(formatNotice("")).toBe("Unknown error");
		expect(formatNotice("   ")).toBe("Unknown error");
	});

	test("always produces a short single line", () => {
		const notice = formatNotice(
			"The provider rejected the request because the account is not entitled to this feature at this" +
				" time",
		);

		expect(notice.split("\n")).toHaveLength(1);
		expect(notice.split(/\s+/).length).toBeLessThanOrEqual(9);
		expect(notice[0]).toBe(notice[0]!.toUpperCase());
	});
});
