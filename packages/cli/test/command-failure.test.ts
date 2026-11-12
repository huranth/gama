import { describe, expect, it } from "vitest";
import { describeCommandFailure, formatCommandFailure } from "../src/core/tools/command-failure.ts";

describe("command failures", () => {
	it("explains a missing git repository", () => {
		const output = "fatal: not a git repository (or any of the parent directories): .git";

		expect(describeCommandFailure(output, 128)).toEqual({
			error: "No git",
			hint: "Git init",
		});
		expect(formatCommandFailure(output, 128)).toBe(
			"Command failed\n" + "Reason: No git\n" + "Next: Git init",
		);
	});

	it("explains a missing command from the exit code", () => {
		expect(formatCommandFailure("", 127)).toBe(
			"Command failed\n" + "Reason: Not found\n" + "Next: Install",
		);
	});

	it("explains a bare git failure from its command", () => {
		expect(formatCommandFailure("----GIT----", 128, "git status")).toBe(
			"Command failed\n" + "Reason: Git fatal\n" + "Next: Check repo",
		);
	});

	it("uses a specific fallback for an unknown output and exit code", () => {
		expect(formatCommandFailure("out", 3)).toBe(
			"Command failed\n" + "Reason: Exit 3\n" + "Next: Check script logic",
		);
	});

	it("never uses the old generic fallback", () => {
		const text = formatCommandFailure("unexpected wall", 3);

		expect(text).not.toContain("Unknown error");
		expect(text).not.toContain("Read output");
	});

	it("leaves a clean exit alone", () => {
		expect(describeCommandFailure("out", 0)).toBeUndefined();
	});

	it("does not reuse an old error far from the end", () => {
		const output = ["permission denied", ...Array.from({ length: 12 }, () => "test failed")].join(
			"\n",
		);

		expect(describeCommandFailure(output, 1)).toEqual({
			error: "Test failed",
			hint: "Fix failing test",
		});
	});

	it("still explains a failure near the end", () => {
		const output = ["noise", "noise", "bash: deploy.sh: Permission denied"].join("\n");

		expect(describeCommandFailure(output, 1)).toEqual({
			error: "Permission denied",
			hint: "Check permissions",
		});
	});

	it("finds a failure at the top of a long stack trace", () => {
		const output = [
			"node:internal/modules/cjs/loader:1228",
			"  throw err;",
			"  ^",
			"Error: ENOENT: no such file or directory, open 'missing.json'",
			...Array.from(
				{ length: 20 },
				() => "    at Module._load (node:internal/modules/cjs/loader:922:12)",
			),
		].join("\n");

		expect(describeCommandFailure(output, 1)).toEqual({
			error: "Path missing",
			hint: "Check path",
		});
	});

	it.each([
		[
			"npm ERR! code ERESOLVE\nnpm ERR! unable to resolve dependency tree",
			{ error: "Dependency conflict", hint: "Fix versions" },
		],
		[
			"src/app.ts(1,2): error TS2322: Type 'string' is not assignable to type 'number'.",
			{ error: "TypeScript error", hint: "Fix type" },
		],
		[
			"ModuleNotFoundError: No module named 'requests'",
			{ error: "Module missing", hint: "Install module" },
		],
		[
			"Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
			{ error: "Docker down", hint: "Start Docker" },
		],
		["HTTP 404 Not Found", { error: "HTTP 404", hint: "Check URL" }],
		["Access is denied.", { error: "Permission denied", hint: "Check permissions" }],
		["No space left on device", { error: "Disk full", hint: "Free disk space" }],
		["fatal: something new", { error: "fatal: something new", hint: "Check command" }],
	])("explains %s", (output, expected) => {
		expect(describeCommandFailure(output, 1)).toEqual(expected);
	});

	it("spots a jest FAIL line after earlier noise", () => {
		const output = ["Running tests", "warmup ok", "FAIL src/app.test.ts"].join("\n");

		expect(describeCommandFailure(output, 1)).toEqual({
			error: "Test failed",
			hint: "Fix failing test",
		});
	});

	it("explains a killed process without output", () => {
		expect(describeCommandFailure("", 137)).toEqual({
			error: "Killed",
			hint: "Check memory",
		});
	});
});
