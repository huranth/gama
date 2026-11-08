import { describe, expect, it, vi } from "vitest";
import type { FindOperations } from "../src/core/tools/find.ts";

// Fake path
const fake = vi.hoisted(() => ({ path: "/missing/fd" }));

vi.mock("../src/utils/tools-manager.ts", () => ({
	ensureTool: async () => fake.path,
}));

const { createFindToolDefinition } = await import("../src/core/tools/find.ts");

// No glob
const operations = { exists: () => true } as unknown as FindOperations;

function run() {
	const tool = createFindToolDefinition(process.cwd(), { operations });

	return tool.execute(
		"find-spawn",
		{ pattern: "*.ts" },
		undefined,
		undefined,
		{} as Parameters<typeof tool.execute>[4],
	);
}

describe("find spawn failure", () => {
	it("reports the spawn cause", async () => {
		fake.path = "/missing/fd";

		await expect(run()).rejects.toThrow(/Find failed: .*ENOENT/);
	});

	it("reports fd stderr", async () => {
		// Node rejects
		fake.path = process.execPath;

		await expect(run()).rejects.toThrow(/Find failed: .*bad option/);
	});
});
