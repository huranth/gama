import { getSystemMessageText } from "@huranth/gama-ai";
import { getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

const WORKING_SECTION =
	`Working in this conversation:

Your tool results stay in this conversation permanently — everything you pull in, ` +
	`you re-read from then on. Keep it full of what helps and free of what doesn't.

Depth comes from following the trail, not from volume: find the few files that ` +
	`decide the question — implementation, callers, tests — and read them carefully. ` +
	`Verify in the real code before claiming how something works; a claim you can point ` +
	`to a line for beats a plausible guess.

Be deliberate about what you bring in:
- Look before you load: grep, find, or ls to map the ground, then read the ` +
	`specific ranges that matter.
- Never pull in bulk artifacts wholesale — lockfiles, build output, dependencies, ` +
	`logs, data files. Grep for the symbol or sample a few lines.
- Re-read only what changed.
- Keep commands tight: narrow patterns, head or tail with line numbers, counts instead of dumps.

Talk to the user like a colleague: lead with the finding, then the evidence, ` +
	`plainly and without filler.`;

export interface BuildSystemPromptOptions {
	customPrompt?: string;
	forceSystemPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	toolGuidelines?: Record<string, string[]>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	sections?: Record<string, string>;
	cwd: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: Skill[];
}

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

export type SystemPromptSections = Record<string, string>;

export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

export function normalizeBuildSystemPromptOptions(
	input: BuildSystemPromptOptions,
): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? ["read", "bash", "edit", "write"])],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [
				name,
				[...guidelines],
			]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};

	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}

	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}

	return Object.keys(patch).length > 0 ? patch : undefined;
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	const entries = contextFiles.map(
		({ path, content }) =>
			`<project_instructions path="${path}">\n${content}\n</project_instructions>`,
	);

	return ["Project-specific instructions and guidelines:", ...entries].join("\n\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;

		seen.add(normalized);
		rules.push(normalized);
	};

	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");

	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addRule(
				"Use bash or PowerShell for file operations like listing, searching, and finding files",
			);
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) {
			addRule(rule);
		}
	}

	for (const rule of promptGuidelines) {
		addRule(rule);
	}

	addRule("Be concise in your responses");
	addRule(
		"Batch independent tool calls together; between batches, a line or two on " +
			"what you are doing and why is welcome, narrating every step is not required",
	);
	addRule("Show file paths clearly when working with files");
	addRule(
		"Check live state (running processes, logs, installed vs source) before describing a system",
	);

	return rules.map((rule) => `- ${rule}`).join("\n");
}

export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		contextFiles,
		skills,
	} = options;

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else {
		promptSections.preamble =
			"You are an experienced software engineer working directly with the user, in their " +
			"terminal and their codebase. You read their code, run commands, edit files, and " +
			"write new ones. Speak plainly, in first person, as yourself.";
		const visibleTools = selectedTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0
				? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
				: "(none)";

		promptSections.tools =
			`${tools}\n\nIn addition to the tools above, ` +
			"you may have access to other custom tools depending on the project.";
		promptSections.working = WORKING_SECTION;
		promptSections.rules = buildRules(selectedTools, toolGuidelines, promptGuidelines);
		promptSections.docs =
			"Gama documentation (read only when the user asks about gama itself, its SDK, " +
			`extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading examples, resolve examples/... under Examples, not the current working directory`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);

	const skillFileReadTool = (["read", "bash"] as const).find((tool) =>
		selectedTools.includes(tool),
	);
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}

	promptSections.cwd = cwd.replace(/\\/g, "/");

	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
	}

	const sections: SystemPromptSections = { preamble: promptSections.preamble };

	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}

	return sections;
}
