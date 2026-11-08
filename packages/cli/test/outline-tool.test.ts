import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOutlineTool,
	type OutlineEntry,
	type OutlineToolDetails,
} from "../src/core/tools/outline.ts";

const MAX_OUTPUT_BYTES = 16 * 1024;

let dir: string;

function write(name: string, lines: string[]): string {
	writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
	return name;
}

async function run(path: string, limit?: number) {
	const tool = createOutlineTool(dir);
	const result = await tool.execute("index-test", { path, limit });
	const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

	return { text, details: result.details as OutlineToolDetails };
}

function find(details: OutlineToolDetails, name: string): OutlineEntry | undefined {
	return details.entries.find((entry) => entry.name === name);
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "gama-outline-tool-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("index tool", () => {
	it("indexes TypeScript declarations and class members", async () => {
		const name = write("sample.ts", [
			"export class Greeter {",
			"  name: string;",
			"",
			"  greet(who: string) {",
			'    return "Hi " + who;',
			"  }",
			"}",
			"",
			"export function add(a: number, b: number) {",
			"  return a + b;",
			"}",
			"",
			"type Point = {",
			"  x: number;",
			"};",
			"",
			"interface Named {",
			"  name: string;",
			"}",
			"",
			"export const answer = 42;",
		]);

		const { text, details } = await run(name);

		expect(details.language).toBe("ts");
		expect(find(details, "class Greeter")).toMatchObject({ start: 1, end: 7, depth: 0 });
		expect(find(details, "field name")).toMatchObject({ start: 2, end: 2, depth: 1 });
		expect(find(details, "method greet")).toMatchObject({ start: 4, end: 6, depth: 1 });
		expect(find(details, "function add")).toMatchObject({ start: 9, end: 11, depth: 0 });
		expect(find(details, "type Point")).toMatchObject({ start: 13, end: 15, depth: 0 });
		expect(find(details, "interface Named")).toMatchObject({ start: 17, end: 19, depth: 0 });
		expect(find(details, "const answer")).toMatchObject({ start: 21, end: 21, depth: 0 });
		expect(text).toContain("  1-7 class Greeter");
		expect(text).toContain("    4-6 method greet");
		expect(text).toContain("sample.ts (21 lines)");
	});

	it("indexes Python blocks by indentation", async () => {
		const name = write("sample.py", [
			"def top():",
			"    def inner():",
			"        return 1",
			"",
			"    return inner()",
			"",
			"class Box:",
			"    def __init__(self):",
			"        self.value = 1",
			"",
			"    def get(self):",
			"        return self.value",
		]);

		const { details } = await run(name);

		expect(details.language).toBe("python");
		expect(find(details, "def top")).toMatchObject({ start: 1, end: 5, depth: 0 });
		expect(find(details, "def inner")).toMatchObject({ start: 2, end: 3, depth: 1 });
		expect(find(details, "class Box")).toMatchObject({ start: 7, end: 12, depth: 0 });
		expect(find(details, "def __init__")).toMatchObject({ start: 8, end: 9, depth: 1 });
		expect(find(details, "def get")).toMatchObject({ start: 11, end: 12, depth: 1 });
	});

	it("indexes Rust items", async () => {
		const name = write("sample.rs", [
			"pub struct Point {",
			"    x: i32,",
			"}",
			"",
			"impl Point {",
			"    pub fn new(x: i32) -> Self {",
			"        Self { x }",
			"    }",
			"}",
			"",
			"fn main() {",
			'    println!("hi");',
			"}",
		]);

		const { details } = await run(name);

		expect(details.language).toBe("rust");
		expect(find(details, "struct Point")).toMatchObject({ start: 1, end: 3, depth: 0 });
		expect(find(details, "impl Point")).toMatchObject({ start: 5, end: 9, depth: 0 });
		expect(find(details, "fn main")).toMatchObject({ start: 11, end: 13, depth: 0 });
	});

	it("indexes Markdown sections", async () => {
		const name = write("sample.md", [
			"# Title",
			"intro",
			"",
			"## Setup",
			"steps",
			"",
			"Details",
			"-------",
			"more",
			"",
			"### Deep",
			"text",
		]);

		const { details } = await run(name);

		expect(details.language).toBe("markdown");
		expect(find(details, "Title")).toMatchObject({ start: 1, end: 3, depth: 0 });
		expect(find(details, "Setup")).toMatchObject({ start: 4, end: 6, depth: 0 });
		expect(find(details, "Details")).toMatchObject({ start: 7, end: 10, depth: 0 });
		expect(find(details, "Deep")).toMatchObject({ start: 11, end: 12, depth: 0 });
	});

	it("indexes JSON top-level keys", async () => {
		const name = write("sample.json", [
			"{",
			'  "name": "demo",',
			'  "scripts": {',
			'    "build": "tsc"',
			"  },",
			'  "version": "1.0.0"',
			"}",
		]);

		const { details } = await run(name);

		expect(details.language).toBe("json");
		expect(find(details, "name")).toMatchObject({ start: 2, end: 2, depth: 0 });
		expect(find(details, "scripts")).toMatchObject({ start: 3, end: 5, depth: 0 });
		expect(find(details, "version")).toMatchObject({ start: 6, end: 6, depth: 0 });
	});

	it("reports a missing path", async () => {
		await expect(run("missing.ts")).rejects.toThrow("Path missing");
	});

	it("keeps output under the byte cap", async () => {
		const lines: string[] = [];
		for (let index = 0; index < 1000; index++) {
			lines.push(`export const aVeryLongDeclarationName${index} = ${index};`);
		}
		const name = write("large.ts", lines);

		const { text, details } = await run(name, 1000);

		expect(details.truncated).toBe(true);
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(MAX_OUTPUT_BYTES);
		expect(text).toContain("... ");
		expect(text).toContain(" more");
	});

	it("caps entries at the limit", async () => {
		const name = write("many.ts", [
			"export const one = 1;",
			"export const two = 2;",
			"export const three = 3;",
			"export const four = 4;",
			"export const five = 5;",
		]);

		const { text, details } = await run(name, 2);

		expect(details.entries).toHaveLength(2);
		expect(details.truncated).toBe(true);
		expect(text).toContain("... 3 more");
	});
});
