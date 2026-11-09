import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, test } from "vitest";
import { getAgentDir } from "../src/config.ts";
import {
	expandPromptTemplate,
	loadPromptTemplates,
	parseCommandArgs,
	substituteArgs,
} from "../src/core/prompt-templates.ts";

describe("substituteArgs", () => {
	test("replace $ARGUMENTS with all args joined", () => {
		expect(substituteArgs("Test: $ARGUMENTS", ["a", "b", "c"])).toBe("Test: a b c");
	});

	test("replace $@ with all args joined", () => {
		expect(substituteArgs("Test: $@", ["a", "b", "c"])).toBe("Test: a b c");
	});

	test("replace $@ and $ARGUMENTS identically", () => {
		const args = ["foo", "bar", "baz"];
		expect(substituteArgs("Test: $@", args)).toBe(substituteArgs("Test: $ARGUMENTS", args));
	});

	test("NOTT recursively substitute patterns in argument values", () => {
		expect(substituteArgs("$ARGUMENTS", ["$1", "$ARGUMENTS"])).toBe("$1 $ARGUMENTS");
		expect(substituteArgs("$@", ["$100", "$1"])).toBe("$100 $1");
		expect(substituteArgs("$ARGUMENTS", ["$100", "$1"])).toBe("$100 $1");
	});

	test("support mixed $1, $2, and $ARGUMENTS", () => {
		expect(substituteArgs("$1: $ARGUMENTS", ["prefix", "a", "b"])).toBe("prefix: prefix a b");
	});

	test("support mixed $1, $2, and $@", () => {
		expect(substituteArgs("$1: $@", ["prefix", "a", "b"])).toBe("prefix: prefix a b");
	});

	test("handle empty arguments array with $ARGUMENTS", () => {
		expect(substituteArgs("Test: $ARGUMENTS", [])).toBe("Test: ");
	});

	test("handle empty arguments array with $@", () => {
		expect(substituteArgs("Test: $@", [])).toBe("Test: ");
	});

	test("handle empty arguments array with $1", () => {
		expect(substituteArgs("Test: $1", [])).toBe("Test: ");
	});

	test("handle multiple occurrences of $ARGUMENTS", () => {
		expect(substituteArgs("$ARGUMENTS and $ARGUMENTS", ["a", "b"])).toBe("a b and a b");
	});

	test("handle multiple occurrences of $@", () => {
		expect(substituteArgs("$@ and $@", ["a", "b"])).toBe("a b and a b");
	});

	test("handle mixed occurrences of $@ and $ARGUMENTS", () => {
		expect(substituteArgs("$@ and $ARGUMENTS", ["a", "b"])).toBe("a b and a b");
	});

	test("handle special characters in arguments", () => {
		expect(substituteArgs("$1 $2: $ARGUMENTS", ["arg100", "@user"])).toBe(
			"arg100 @user: arg100 @user",
		);
	});

	test("handle out-of-range numbered placeholders", () => {
		expect(substituteArgs("$1 $2 $3 $4 $5", ["a", "b"])).toBe("a b   ");
	});

	test("handle unicode characters", () => {
		expect(substituteArgs("$ARGUMENTS", ["日本語", "🎉", "café"])).toBe("日本語 🎉 café");
	});

	test("preserve newlines and tabs in argument values", () => {
		expect(substituteArgs("$1 $2", ["line1\nline2", "tab\tthere"])).toBe(
			"line1\nline2 tab\tthere",
		);
	});

	test("handle consecutive dollar patterns", () => {
		expect(substituteArgs("$1$2", ["a", "b"])).toBe("ab");
	});

	test("handle quoted arguments with spaces", () => {
		expect(substituteArgs("$ARGUMENTS", ["first arg", "second arg"])).toBe(
			"first arg second arg",
		);
	});

	test("handle single argument with $ARGUMENTS", () => {
		expect(substituteArgs("Test: $ARGUMENTS", ["only"])).toBe("Test: only");
	});

	test("handle single argument with $@", () => {
		expect(substituteArgs("Test: $@", ["only"])).toBe("Test: only");
	});

	test("handle $0 (zero index)", () => {
		expect(substituteArgs("$0", ["a", "b"])).toBe("");
	});

	test("handle decimal number in pattern (only integer part matches)", () => {
		expect(substituteArgs("$1.5", ["a"])).toBe("a.5");
	});

	test("handle $ARGUMENTS as part of word", () => {
		expect(substituteArgs("pre$ARGUMENTS", ["a", "b"])).toBe("prea b");
	});

	test("handle $@ as part of word", () => {
		expect(substituteArgs("pre$@", ["a", "b"])).toBe("prea b");
	});

	test("handle empty arguments in middle of list", () => {
		expect(substituteArgs("$ARGUMENTS", ["a", "", "c"])).toBe("a  c");
	});

	test("handle trailing and leading spaces in arguments", () => {
		expect(substituteArgs("$ARGUMENTS", ["  leading  ", "trailing  "])).toBe(
			"  leading   trailing  ",
		);
	});

	test("handle argument containing pattern partially", () => {
		expect(substituteArgs("Prefix $ARGUMENTS suffix", ["ARGUMENTS"])).toBe(
			"Prefix ARGUMENTS suffix",
		);
	});

	test("handle non-matching patterns", () => {
		expect(substituteArgs("$A $$ $ $ARGS", ["a"])).toBe("$A $$ $ $ARGS");
	});

	test("handle case variations (case-sensitive)", () => {
		expect(substituteArgs("$arguments $Arguments $ARGUMENTS", ["a", "b"])).toBe(
			"$arguments $Arguments a b",
		);
	});

	test("handle both syntaxes in same command with same result", () => {
		const args = ["x", "y", "z"];
		const result1 = substituteArgs("$@ and $ARGUMENTS", args);
		const result2 = substituteArgs("$ARGUMENTS and $@", args);
		expect(result1).toBe(result2);
		expect(result1).toBe("x y z and x y z");
	});

	test("handle very long argument lists", () => {
		const args = Array.from({ length: 100 }, (_, i) => `arg${i}`);
		const result = substituteArgs("$ARGUMENTS", args);
		expect(result).toBe(args.join(" "));
	});

	test("handle numbered placeholders with single digit", () => {
		expect(substituteArgs("$1 $2 $3", ["a", "b", "c"])).toBe("a b c");
	});

	test("handle numbered placeholders with multiple digits", () => {
		const args = Array.from({ length: 15 }, (_, i) => `val${i}`);
		expect(substituteArgs("$10 $12 $15", args)).toBe("val9 val11 val14");
	});

	test("handle escaped dollar signs (literal backslash preserved)", () => {
		expect(substituteArgs("Price: \\$100", [])).toBe("Price: \\");
	});

	test("handle mixed numbered and wildcard placeholders", () => {
		expect(substituteArgs("$1: $@ ($ARGUMENTS)", ["first", "second", "third"])).toBe(
			"first: first second third (first second third)",
		);
	});

	test("handle command with no placeholders", () => {
		expect(substituteArgs("Just plain text", ["a", "b"])).toBe("Just plain text");
	});

	test("handle command with only placeholders", () => {
		expect(substituteArgs("$1 $2 $@", ["a", "b", "c"])).toBe("a b a b c");
	});
});

describe("substituteArgs - positional defaults", () => {
	test("use default when positional arg is missing", () => {
		expect(substituteArgs(`List exactly \${1:-7} next steps`, [])).toBe(
			"List exactly 7 next steps",
		);
	});

	test("support defaults for all arguments", () => {
		const template = `\${@:-default}\n\${ARGUMENTS:-default}`;

		expect(substituteArgs(template, [])).toBe("default\ndefault");
		expect(substituteArgs(template, ["This", "would", "be", "the", "arguments"])).toBe(
			"This would be the arguments\nThis would be the arguments",
		);
	});

	test("use positional arg when present", () => {
		expect(substituteArgs(`List exactly \${1:-7} next steps`, ["3"])).toBe(
			"List exactly 3 next steps",
		);
	});

	test("use default when positional arg is empty", () => {
		expect(substituteArgs(`Mode: \${1:-brief}`, [""])).toBe("Mode: brief");
	});

	test("support multiple positional defaults", () => {
		expect(substituteArgs(`\${1:-7} \${2:-brief}`, [])).toBe("7 brief");
		expect(substituteArgs(`\${1:-7} \${2:-brief}`, ["3"])).toBe("3 brief");
		expect(substituteArgs(`\${1:-7} \${2:-brief}`, ["3", "verbose"])).toBe("3 verbose");
	});

	test("not recursively substitute patterns in arg values", () => {
		expect(substituteArgs(`\${1:-7}`, ["$ARGUMENTS"])).toBe("$ARGUMENTS");
		expect(substituteArgs(`\${1:-7}`, ["$1"])).toBe("$1");
	});

	test("not recursively substitute patterns in default values", () => {
		expect(substituteArgs(`\${1:-$ARGUMENTS}`, ["a", "b"])).toBe("a");
		expect(substituteArgs(`\${3:-$ARGUMENTS}`, ["a", "b"])).toBe("$ARGUMENTS");
	});

	test("support defaults with spaces", () => {
		expect(substituteArgs(`\${1:-seven steps}`, [])).toBe("seven steps");
	});

	test("support out-of-range positional defaults", () => {
		expect(substituteArgs(`\${3:-fallback}`, ["a", "b"])).toBe("fallback");
	});

	test("fix positional defaults with existing placeholders", () => {
		expect(substituteArgs(`$1 \${2:-x} $ARGUMENTS`, ["a"])).toBe("a x a");
	});
});

describe("substituteArgs - array slicing", () => {
	test(`slice from index (\${@:N})`, () => {
		expect(substituteArgs(`\${@:2}`, ["a", "b", "c", "d"])).toBe("b c d");
		expect(substituteArgs(`\${@:1}`, ["a", "b", "c"])).toBe("a b c");
		expect(substituteArgs(`\${@:3}`, ["a", "b", "c", "d"])).toBe("c d");
	});

	test(`slice with length (\${@:N:L})`, () => {
		expect(substituteArgs(`\${@:2:2}`, ["a", "b", "c", "d"])).toBe("b c");
		expect(substituteArgs(`\${@:1:1}`, ["a", "b", "c"])).toBe("a");
		expect(substituteArgs(`\${@:3:1}`, ["a", "b", "c", "d"])).toBe("c");
		expect(substituteArgs(`\${@:2:3}`, ["a", "b", "c", "d", "e"])).toBe("b c d");
	});

	test("handle out of range slices", () => {
		expect(substituteArgs(`\${@:99}`, ["a", "b"])).toBe("");
		expect(substituteArgs(`\${@:5}`, ["a", "b"])).toBe("");
		expect(substituteArgs(`\${@:10:5}`, ["a", "b"])).toBe("");
	});

	test("handle zero-length slices", () => {
		expect(substituteArgs(`\${@:2:0}`, ["a", "b", "c"])).toBe("");
		expect(substituteArgs(`\${@:1:0}`, ["a", "b"])).toBe("");
	});

	test("handle length exceeding array", () => {
		expect(substituteArgs(`\${@:2:99}`, ["a", "b", "c"])).toBe("b c");
		expect(substituteArgs(`\${@:1:10}`, ["a", "b"])).toBe("a b");
	});

	test("process slice before simple $@", () => {
		expect(substituteArgs(`\${@:2} vs $@`, ["a", "b", "c"])).toBe("b c vs a b c");
		expect(substituteArgs(`First: \${@:1:1}, All: $@`, ["x", "y", "z"])).toBe(
			"First: x, All: x y z",
		);
	});

	test("not recursively substitute slice patterns in args", () => {
		expect(substituteArgs(`\${@:1}`, [`\${@:2}`, "test"])).toBe(`\${@:2} test`);
		expect(substituteArgs(`\${@:2}`, ["a", `\${@:3}`, "c"])).toBe(`\${@:3} c`);
	});

	test("handle mixed usage with positional args", () => {
		expect(substituteArgs(`$1: \${@:2}`, ["cmd", "arg1", "arg2"])).toBe("cmd: arg1 arg2");
		expect(substituteArgs(`$1 $2 \${@:3}`, ["a", "b", "c", "d"])).toBe("a b c d");
	});

	test(`treat \${@:0} as all args`, () => {
		expect(substituteArgs(`\${@:0}`, ["a", "b", "c"])).toBe("a b c");
	});

	test("handle empty args array", () => {
		expect(substituteArgs(`\${@:2}`, [])).toBe("");
		expect(substituteArgs(`\${@:1}`, [])).toBe("");
	});

	test("handle single arg array", () => {
		expect(substituteArgs(`\${@:1}`, ["only"])).toBe("only");
		expect(substituteArgs(`\${@:2}`, ["only"])).toBe("");
	});

	test("handle slice in middle of text", () => {
		expect(substituteArgs(`Process \${@:2} with $1`, ["tool", "file1", "file2"])).toBe(
			"Process file1 file2 with tool",
		);
	});

	test("handle multiple slices in one template", () => {
		expect(substituteArgs(`\${@:1:1} and \${@:2}`, ["a", "b", "c"])).toBe("a and b c");
		expect(substituteArgs(`\${@:1:2} vs \${@:3:2}`, ["a", "b", "c", "d", "e"])).toBe(
			"a b vs c d",
		);
	});

	test("handle quoted arguments in slices", () => {
		expect(substituteArgs(`\${@:2}`, ["cmd", "first arg", "second arg"])).toBe(
			"first arg second arg",
		);
	});

	test("handle special characters in sliced args", () => {
		expect(substituteArgs(`\${@:2}`, ["cmd", "$100", "@user", "#tag"])).toBe("$100 @user #tag");
	});

	test("handle unicode in sliced args", () => {
		expect(substituteArgs(`\${@:1}`, ["日本語", "🎉", "café"])).toBe("日本語 🎉 café");
	});

	test("combine positional, slice, and wildcard placeholders", () => {
		const template = `Run $1 on \${@:2:2}, then process $@`;
		const args = ["eslint", "file1.ts", "file2.ts", "file3.ts"];
		expect(substituteArgs(template, args)).toBe(
			"Run eslint on file1.ts file2.ts, then process eslint file1.ts file2.ts file3.ts",
		);
	});

	test("handle slice with no spacing", () => {
		expect(substituteArgs(`prefix\${@:2}suffix`, ["a", "b", "c"])).toBe("prefixb csuffix");
	});

	test("handle large slice lengths gracefully", () => {
		const args = Array.from({ length: 10 }, (_, i) => `arg${i + 1}`);
		expect(substituteArgs(`\${@:5:100}`, args)).toBe("arg5 arg6 arg7 arg8 arg9 arg10");
	});
});

describe("parseCommandArgs", () => {
	test("parse simple space-separated arguments", () => {
		expect(parseCommandArgs("a b c")).toEqual(["a", "b", "c"]);
	});

	test("parse quoted arguments with spaces", () => {
		expect(parseCommandArgs('"first arg" second')).toEqual(["first arg", "second"]);
	});

	test("parse single-quoted arguments", () => {
		expect(parseCommandArgs("'first arg' second")).toEqual(["first arg", "second"]);
	});

	test("parse mixed quote styles", () => {
		expect(parseCommandArgs('"double" \'single\' "double again"')).toEqual([
			"double",
			"single",
			"double again",
		]);
	});

	test("handle empty string", () => {
		expect(parseCommandArgs("")).toEqual([]);
	});

	test("handle extra spaces", () => {
		expect(parseCommandArgs("a  b   c")).toEqual(["a", "b", "c"]);
	});

	test("handle tabs as separators", () => {
		expect(parseCommandArgs("a\tb\tc")).toEqual(["a", "b", "c"]);
	});

	test("handle quoted empty string", () => {
		expect(parseCommandArgs('"" " "')).toEqual([" "]);
	});

	test("handle arguments with special characters", () => {
		expect(parseCommandArgs("$100 @user #tag")).toEqual(["$100", "@user", "#tag"]);
	});

	test("handle unicode characters", () => {
		expect(parseCommandArgs("日本語 🎉 café")).toEqual(["日本語", "🎉", "café"]);
	});

	test("handle newlines in quoted arguments", () => {
		expect(parseCommandArgs('"line1\nline2" second')).toEqual(["line1\nline2", "second"]);
	});

	test("treat unquoted newlines as separators", () => {
		expect(parseCommandArgs("label-2\n\nHere is some description #2.")).toEqual([
			"label-2",
			"Here",
			"is",
			"some",
			"description",
			"#2.",
		]);
	});

	test("collapse mixed unquoted whitespace", () => {
		expect(parseCommandArgs("a\n\n\tb  c")).toEqual(["a", "b", "c"]);
	});

	test("handle escaped quotes inside quoted strings", () => {
		expect(parseCommandArgs('"quoted \\"text\\""')).toEqual(["quoted \\text\\"]);
	});

	test("handle trailing spaces", () => {
		expect(parseCommandArgs("a b c   ")).toEqual(["a", "b", "c"]);
	});

	test("handle leading spaces", () => {
		expect(parseCommandArgs("   a b c")).toEqual(["a", "b", "c"]);
	});
});

describe("expandPromptTemplate", () => {
	test("split template arguments on unquoted newlines", () => {
		const result = expandPromptTemplate("/arg-test label-2\n\nHere is some description #2.", [
			{
				name: "arg-test",
				description: "test",
				content: `- arg1: $1\n- rest: \${@:2}`,
				sourceInfo: {
					path: "/tmp/arg-test.md",
					source: "local",
					scope: "temporary",
					origin: "top-level",
				},
				filePath: "/tmp/arg-test.md",
			},
		]);

		expect(result).toBe("- arg1: label-2\n- rest: Here is some description #2.");
	});

	test("support template command separated from args by newline", () => {
		const result = expandPromptTemplate("/arg-test\nlabel-2", [
			{
				name: "arg-test",
				description: "test",
				content: "arg1: $1",
				sourceInfo: {
					path: "/tmp/arg-test.md",
					source: "local",
					scope: "temporary",
					origin: "top-level",
				},
				filePath: "/tmp/arg-test.md",
			},
		]);

		expect(result).toBe("arg1: label-2");
	});
});

describe("parseCommandArgs + substituteArgs integration", () => {
	test("parse and substitute together correctly", () => {
		const input = 'Button "onClick handler" "disabled support"';
		const args = parseCommandArgs(input);
		const template = "Create component $1 with features: $ARGUMENTS";
		const result = substituteArgs(template, args);
		expect(result).toBe(
			"Create component Button with features: Button onClick handler disabled support",
		);
	});

	test("handle the example from README", () => {
		const input = 'Button "onClick handler" "disabled support"';
		const args = parseCommandArgs(input);
		const template = "Create a React component named $1 with features: $ARGUMENTS";
		const result = substituteArgs(template, args);
		expect(result).toBe(
			"Create a React component named Button with features: Button onClick handler disabled support",
		);
	});

	test("produce same result with $@ and $ARGUMENTS", () => {
		const args = parseCommandArgs("feature1 feature2 feature3");
		const template1 = "Implement: $@";
		const template2 = "Implement: $ARGUMENTS";
		expect(substituteArgs(template1, args)).toBe(substituteArgs(template2, args));
	});
});

describe("loadPromptTemplates - argument-hint", () => {
	const testDir = join(tmpdir(), `gama-test-prompts-${Date.now()}`);

	function writeTemplate(name: string, content: string) {
		mkdirSync(testDir, { recursive: true });
		writeFileSync(join(testDir, `${name}.md`), content);
	}

	test("parse required argument-hint from frontmatter", () => {
		writeTemplate(
			"pr",
			`---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
You are given one or more GitHub PR URLs: $@`,
		);

		const { templates } = loadPromptTemplates({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			promptPaths: [testDir],
			includeDefaults: false,
		});

		const pr = templates.find((t) => t.name === "pr");
		expect(pr).toBeDefined();
		expect(pr!.argumentHint).toBe("<PR-URL>");
		expect(pr!.description).toBe("Review PRs from URLs with structured issue and code analysis");
	});

	test("parse optional argument-hint from frontmatter", () => {
		writeTemplate(
			"wr",
			`---
description: Finish the current task end-to-end with changelog, commit, and push
argument-hint: "[instructions]"
---
Wrap it. Additional instructions: $ARGUMENTS`,
		);

		const { templates } = loadPromptTemplates({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			promptPaths: [testDir],
			includeDefaults: false,
		});

		const wr = templates.find((t) => t.name === "wr");
		expect(wr).toBeDefined();
		expect(wr!.argumentHint).toBe("[instructions]");
		expect(wr!.description).toBe(
			"Finish the current task end-to-end with changelog, commit, and push",
		);
	});

	test("leave argumentHint undefined when not specified", () => {
		writeTemplate(
			"cl",
			`---
description: Audit changelog entries before release
---
Audit changelog entries for all commits since the last release.`,
		);

		const { templates } = loadPromptTemplates({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			promptPaths: [testDir],
			includeDefaults: false,
		});

		const cl = templates.find((t) => t.name === "cl");
		expect(cl).toBeDefined();
		expect(cl!.argumentHint).toBeUndefined();
	});

	test("ignore empty argument-hint", () => {
		writeTemplate(
			"empty-hint",
			`---
description: A command with empty hint
argument-hint: ""
---
Do something`,
		);

		const { templates } = loadPromptTemplates({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			promptPaths: [testDir],
			includeDefaults: false,
		});

		const tmpl = templates.find((t) => t.name === "empty-hint");
		expect(tmpl).toBeDefined();
		expect(tmpl!.argumentHint).toBeUndefined();
	});

	test("preserve argument-hint with special characters", () => {
		writeTemplate(
			"is",
			`---
description: Analyze GitHub issues (bugs or feature requests)
argument-hint: "<issue>"
---
Analyze GitHub issue(s): $ARGUMENTS`,
		);

		const { templates } = loadPromptTemplates({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			promptPaths: [testDir],
			includeDefaults: false,
		});

		const is = templates.find((t) => t.name === "is");
		expect(is).toBeDefined();
		expect(is!.argumentHint).toBe("<issue>");
	});

	afterAll(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {}
	});
});

describe("loadPromptTemplates - diagnostics", () => {
	test("reports invalid YAML frontmatter and keeps valid siblings", () => {
		const testDir = mkdtempSync(join(tmpdir(), "gama-test-prompts-invalid-"));
		const invalidPromptPath = join(testDir, "invalid.md");
		try {
			writeFileSync(
				invalidPromptPath,
				"---\ndescription: Broken: unquoted colon\n---\nDo something.\n",
			);
			writeFileSync(join(testDir, "valid.md"), "Valid prompt content.");

			const { templates, diagnostics } = loadPromptTemplates({
				cwd: process.cwd(),
				agentDir: getAgentDir(),
				promptPaths: [testDir],
				includeDefaults: false,
			});

			expect(templates.map((template) => template.name)).toEqual(["valid"]);
			expect(diagnostics).toEqual([
				expect.objectContaining({
					type: "warning",
					path: invalidPromptPath,
					message: expect.stringContaining("line 1, column 14"),
				}),
			]);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
