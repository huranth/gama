import { describe, expect, test } from "vitest";
import { findExtensionStackMatches } from "../src/core/crash-log.ts";

type StackExtension = Parameters<typeof findExtensionStackMatches>[1][number];

function packageExtension(
	source: string,
	baseDir: string,
	entry = "extensions/index.ts",
): StackExtension {
	const normalizedBaseDir = baseDir.replace(/\\/g, "/");
	const resolvedPath = `${normalizedBaseDir}/${entry}`;
	return {
		path: resolvedPath,
		resolvedPath,
		sourceInfo: {
			path: resolvedPath,
			source,
			scope: "user",
			origin: "package",
			baseDir,
		},
	};
}

describe("extension crash attribution", () => {
	test("matches stack frames beneath loaded package roots", () => {
		const memory = packageExtension(
			"npm:gama-observational-memory",
			"/home/user/.gama/agent/npm/node_modules/gama-observational-memory",
		);
		const unrelated = packageExtension(
			"npm:unrelated",
			"/home/user/.gama/agent/npm/node_modules/unrelated",
		);
		const stack =
			"TypeError: Cannot read properties of undefined (reading 'runtime')\n" +
			"    at streamSimple (file:///home/user/.local/lib/node_modules/@huranth/gama-coding-agent/dist/bundle/chunks/chunk-CMRUVXTE.js:1093:16944)\n" +
			"    at /home/user/.gama/agent/npm/node_modules/gama-observational-memory/src/agents/worker-stream.ts:43:45";

		expect(findExtensionStackMatches(stack, [memory, unrelated])).toEqual([
			"npm:gama-observational-memory",
		]);
	});

	test("normalizes Windows paths and deduplicates package extensions", () => {
		const root = "C:\\Users\\reporter\\.gama\\agent\\npm\\node_modules\\@scope\\memory";
		const first = packageExtension("npm:@scope/memory", root, "extensions/first.ts");
		const second = packageExtension("npm:@scope/memory", root, "extensions/second.ts");
		const stack =
			"Error: broken\n" +
			"    at run (c:\\users\\reporter\\.gama\\agent\\npm\\node_modules\\@scope\\memory\\src\\worker.ts:4:2)";

		expect(findExtensionStackMatches(stack, [first, second])).toEqual(["npm:@scope/memory"]);
	});

	test("does not attribute sibling single-file packages", () => {
		const extension = (name: string): StackExtension => ({
			path: `/plugins/${name}.ts`,
			resolvedPath: `/plugins/${name}.ts`,
			sourceInfo: {
				path: `/plugins/${name}.ts`,
				source: `/plugins/${name}.ts`,
				scope: "user",
				origin: "package",
				baseDir: "/plugins",
			},
		});
		const stack = "Error: broken\n    at run (file:///plugins/b.ts:4:2)";

		expect(findExtensionStackMatches(stack, [extension("a"), extension("b")])).toEqual([
			"/plugins/b.ts",
		]);
	});

	test("ignores extension paths in the error message", () => {
		const extension = packageExtension("npm:memory", "/tmp/node_modules/memory");
		const stack = `Error: Failed to read ${extension.resolvedPath}\n    at run (file:///opt/gama/dist/core.js:4:2)`;

		expect(findExtensionStackMatches(stack, [extension])).toEqual([]);
	});

	test("decodes frame paths independently from malformed error text", () => {
		const extension: StackExtension = {
			path: "/Users/reporter/.gama/agent/extensions/local memory/index.ts",
			resolvedPath: "/Users/reporter/.gama/agent/extensions/local memory/index.ts",
			sourceInfo: {
				path: "/Users/reporter/.gama/agent/extensions/local memory/index.ts",
				source: "local",
				scope: "user",
				origin: "top-level",
				baseDir: "/Users/reporter/.gama/agent/extensions",
			},
		};
		const stack =
			"Error: progress 100%\n    at run (file:///Users/reporter/.gama/agent/extensions/local%20memory/worker.ts:4:2)";

		expect(findExtensionStackMatches(stack, [extension])).toEqual([extension.path]);
	});
});
