import { globSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@huranth/gama-ai";
import { defineTool } from "@huranth/gama-harness";
import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { createGamaCodingAgentHarness } from "../src/harness.ts";

const TOOL_NAME = "submit_documentation_audit";
const submitAudit = defineTool({
	name: TOOL_NAME,
	label: "Submit documentation audit",
	description: "Submit the final verdict after completing the documentation investigation.",
	promptSnippet: "Submit the final documentation audit as validated structured data",
	parameters: Type.Object(
		{
			verdict: Type.Union([
				Type.Literal("match"),
				Type.Literal("mismatch"),
				Type.Literal("inconclusive"),
			]),
			explanation: Type.String({ minLength: 1, maxLength: 2000 }),
		},
		{ additionalProperties: false },
	),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: "Documentation audit submitted." }],
			details: params,
			terminate: true,
		};
	},
});

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const docsRoot = resolve(repositoryRoot, "packages/coding-agent/docs");
const pages = globSync("**/*.md", { cwd: docsRoot })
	.map((path) => ({ path: path.replaceAll("\\", "/") }))
	.sort((left, right) => left.path.localeCompare(right.path));
const harness = createGamaCodingAgentHarness({
	name: "documentation-page-audit",
	tools: ["read", "grep", "find", "ls", TOOL_NAME],
	customTools: [submitAudit],
});

describeEval("Audit documentation against implementation", { harness }, (it) => {
	it.for(pages)("$path matches the implementation", async ({ path }, { run }) => {
		const documentationPath = resolve(docsRoot, path);
		const result = await run(
			`Audit this Gama documentation page against the repository implementation.\n\n` +
				`Documentation page: ${documentationPath}\n` +
				`Repository root: ${repositoryRoot}\n\n` +
				`Read the complete page and the relevant implementation. Report a mismatch ` +
				`only for a clear, user-visible contradiction between an explicit ` +
				`documentation claim and actual runtime behavior. Follow the runtime path; ` +
				`names, comments, types, isolated helpers, and tests are not sufficient ` +
				`evidence by themselves.\n\n` +
				`Missing internal detail, ambiguous wording, hypothetical misuse, and ` +
				`undocumented edge cases are not mismatches. If the evidence is not ` +
				`decisive, report inconclusive. Otherwise report match.\n\n` +
				`For a mismatch, quote the claim, cite the implementation path and symbol, ` +
				`and state the concrete behavior a user would observe.\n\n` +
				`Call ${TOOL_NAME} exactly once as your final action. Do not return prose.`,
		);

		const auditCalls = toolCalls(result).filter((call) => call.name === TOOL_NAME);
		expect(auditCalls).toHaveLength(1);
		const auditCall = auditCalls[0];
		expect(auditCall?.status).toBe("ok");
		const explanation = auditCall?.arguments?.explanation;
		const message = typeof explanation === "string" ? explanation : undefined;
		expect(auditCall?.arguments?.verdict, message).toBe("match");
	});
});
