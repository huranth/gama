import { afterEach, describe, expect, it, vi } from "vitest";
import { runUpdateCommand } from "../src/cli/update-command.ts";
import type { SelfUpdateCommand } from "../src/config.ts";

const npmCommand: SelfUpdateCommand = {
	command: "npm",
	args: ["install", "-g", "--ignore-scripts", "@huranth/gama-harness@1.0.2"],
	display: "npm install -g --ignore-scripts @huranth/gama-harness@1.0.2",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("update command", () => {
	it("stops when the current version is the latest", async () => {
		const run = vi.fn(async () => 0);
		vi.spyOn(console, "log").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "1.0.1" }),
			getCommand: () => npmCommand,
			run,
		});

		expect(exitCode).toBe(0);
		expect(run).not.toHaveBeenCalled();
	});

	it("runs the install method's own command", async () => {
		const run = vi.fn(async () => 0);
		vi.spyOn(console, "log").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "1.0.2" }),
			getCommand: () => npmCommand,
			run,
		});

		expect(exitCode).toBe(0);
		expect(run).toHaveBeenCalledWith("npm", npmCommand.args);
	});

	it("reports an available update without installing when checking only", async () => {
		const run = vi.fn(async () => 0);
		const getCommand = vi.fn(() => npmCommand);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			checkOnly: true,
			fetchLatest: async () => ({ version: "1.0.2" }),
			getCommand,
			run,
		});

		expect(exitCode).toBe(0);
		expect(logSpy).toHaveBeenCalledWith("Update available: 1.0.1 -> 1.0.2");
		expect(getCommand).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("ignores a package name from the endpoint", async () => {
		const run = vi.fn(async () => 0);
		const getCommand = vi.fn(() => npmCommand);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "1.0.2", packageName: "@other/gama" }),
			getCommand,
			run,
		});

		expect(getCommand).toHaveBeenCalledWith("1.0.2");
		expect(run).toHaveBeenCalledWith("npm", npmCommand.args);
	});

	it("rejects a version that is not semver", async () => {
		const run = vi.fn(async () => 0);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "latest" }),
			getCommand: () => npmCommand,
			run,
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Update check returned an invalid version: latest");
		expect(run).not.toHaveBeenCalled();
	});

	it("explains how to update when the install is not managed", async () => {
		const run = vi.fn(async () => 0);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "1.0.2" }),
			getCommand: () => undefined,
			run,
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		expect(run).not.toHaveBeenCalled();
	});

	it("reports a failed install", async () => {
		const run = vi.fn(async () => 2);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "1.0.2" }),
			getCommand: () => npmCommand,
			run,
		});

		expect(exitCode).toBe(2);
		expect(errorSpy).toHaveBeenCalledWith("Update failed");
	});

	it("stops when the first step of a two-step command fails", async () => {
		const run = vi.fn(async () => 1);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "1.0.2" }),
			getCommand: () => ({ ...npmCommand, steps: [npmCommand, npmCommand] }),
			run,
		});

		expect(exitCode).toBe(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reports an unreachable endpoint", async () => {
		const run = vi.fn(async () => 0);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => undefined,
			getCommand: () => npmCommand,
			run,
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Could not check for updates");
		expect(run).not.toHaveBeenCalled();
	});

	it("survives a fetch that throws", async () => {
		const run = vi.fn(async () => 0);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => {
				throw new Error("bad payload");
			},
			getCommand: () => npmCommand,
			run,
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Could not check for updates: bad payload");
		expect(run).not.toHaveBeenCalled();
	});

	it("survives an install that throws", async () => {
		const run = vi.fn(async () => {
			throw new Error("spawn failed");
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runUpdateCommand({
			currentVersion: "1.0.1",
			fetchLatest: async () => ({ version: "1.0.2" }),
			getCommand: () => npmCommand,
			run,
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Update failed: spawn failed");
	});
});
