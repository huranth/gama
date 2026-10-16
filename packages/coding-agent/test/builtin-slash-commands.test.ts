import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("builtin slash commands", () => {
	it("registers /history for browsing past sessions in the current folder", () => {
		const history = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "history");
		expect(history).toEqual({
			name: "history",
			description: "Browse and resume sessions from this folder",
		});
	});

	it("keeps command names unique", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
	});
});
