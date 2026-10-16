import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createFindToolDefinition,
	relativizeFindResultPath,
} from "../../../src/core/tools/find.ts";

describe("issue #6104 find relativizes root search paths", () => {
	describe("Windows drive root", () => {
		const searchRoot = "D:\\";

		it("preserves the first segment and emits one trailing slash for fd directory output", () => {
			expect(relativizeFindResultPath("D:\\work\\models\\gemma4\\", searchRoot, win32)).toBe(
				"work/models/gemma4/",
			);
		});

		it("handles fd output that uses forward slashes under a drive root", () => {
			expect(relativizeFindResultPath("D:/work/models/gemma4/", searchRoot, win32)).toBe(
				"work/models/gemma4/",
			);
		});

		it("keeps deeper search paths unchanged", () => {
			expect(relativizeFindResultPath("D:\\work\\models\\", "D:\\work", win32)).toBe("models/");
		});

		it("does not relativize a sibling directory that shares a name prefix", () => {
			expect(
				relativizeFindResultPath("D:\\work\\models2\\file.txt", "D:\\work\\models", win32),
			).toBe("../models2/file.txt");
		});

		it("normalizes relative custom-glob results without corrupting them", () => {
			expect(relativizeFindResultPath("work\\models\\gemma4\\", searchRoot, win32)).toBe(
				"work/models/gemma4/",
			);
		});
	});

	describe("POSIX root", () => {
		it("preserves the first segment for files under /", () => {
			expect(relativizeFindResultPath("/home/user/file.txt", "/", posix)).toBe(
				"home/user/file.txt",
			);
		});

		it("preserves the first segment and one trailing slash for directories under /", () => {
			expect(relativizeFindResultPath("/home/user/project/", "/", posix)).toBe(
				"home/user/project/",
			);
		});

		it("preserves backslashes in POSIX filenames", () => {
			expect(relativizeFindResultPath("/home/user/file\\", "/home/user", posix)).toBe("file\\");
		});
	});

	describe("absolute results outside the search path", () => {
		it("falls back to path.relative when the absolute paths do not share a prefix", () => {
			expect(
				relativizeFindResultPath("/tmp/results/file.txt", "/workspace/project", posix),
			).toBe("../../tmp/results/file.txt");
		});

		it("keeps a trailing slash on directories resolved through path.relative", () => {
			expect(relativizeFindResultPath("/tmp/results/dir/", "/workspace/project", posix)).toBe(
				"../../tmp/results/dir/",
			);
		});
	});

	describe("through the find tool", () => {
		it("relativizes custom glob results against a root search path", async () => {
			const def = createFindToolDefinition("/", {
				operations: {
					exists: () => true,
					glob: () => ["/home/user/project/", "/home/user/project/file.txt"],
				},
			});
			const ctx = {} as Parameters<typeof def.execute>[4];
			const result = (await def.execute(
				"call-1",
				{ pattern: "**" },
				undefined,
				undefined,
				ctx,
			)) as {
				content: Array<{ type: string; text?: string }>;
			};
			expect(result.content[0]?.text).toBe("home/user/project/\nhome/user/project/file.txt");
		});
	});
});
