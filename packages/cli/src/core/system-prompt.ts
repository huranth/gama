import { getSystemMessageText } from "@huranth/gama-ai";
import { getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

const TOOLS_NOTE = [
	"In addition to the tools above, you may have access to other custom tools",
	"depending on the project.",
].join(" ");

const DEFAULT_PREAMBLE = [
	"You are an experienced software engineer working directly with the user, " +
		"in their terminal and their codebase.",
	"You read their code, run commands, edit files, and write new ones.",
	"Speak plainly, in first person, as yourself.",
].join(" ");

const WORKING_SECTION =
	`Working in this conversation:

Your tool results stay in this conversation permanently, everything ` +
	`you pull in, you re-read from then on.
Keep it full of what helps and free of what doesn't.

Depth comes from following the trail, not from volume: find the few ` +
	`files that decide the question (implementation, callers, tests) and ` +
	`read them carefully.
Verify in the real code before claiming how something works; a claim ` +
	`you can point to a line for beats a plausible guess.

Be deliberate about what you bring in:
- Look before you load: grep, find, or ls to map the ground, then ` +
	`read the specific ranges that matter.
- Never pull in bulk artifacts wholesale: lockfiles, build output, ` +
	`dependencies, logs, data files. Grep for the symbol or sample a few lines.
- Re-read only what changed.
- Keep commands tight: narrow patterns, head or tail with line numbers, counts instead of dumps.

Talk to the user like a colleague: lead with the finding, ` +
	`then the evidence, plainly and without filler.`;

// Shell rules
const SHELL_FILE_RULES: Array<{
	needsBash: boolean;
	needsPowerShell: boolean;
	rule: string;
}> = [
	{
		needsBash: true,
		needsPowerShell: true,
		rule: "Use bash or PowerShell for file operations like listing, searching, and finding files",
	},
	{
		needsBash: false,
		needsPowerShell: true,
		rule: "Use PowerShell for file operations like listing, searching, and finding files",
	},
	{
		needsBash: true,
		needsPowerShell: false,
		rule: "Use bash for file operations like ls, rg, find",
	},
];

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
		selectedTools: [...(input.selectedTools ?? DEFAULT_TOOLS)],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: cloneGuidelines(input.toolGuidelines ?? {}),
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

function cloneGuidelines(
	guidelines: Record<string, string[]>,
): Record<string, string[]> {
	const cloned: Record<string, string[]> = {};

	for (const [name, list] of Object.entries(guidelines)) {
		cloned[name] = [...list];
	}

	return cloned;
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	const entries = contextFiles.map(
		({ path, content }) =>
			`<project_instructions path="${path}">\n${content}\n</project_instructions>`,
	);

	return ["Project-specific instructions and guidelines:", ...entries].join("\n\n");
}

function renderTools(selectedTools: string[], toolSnippets: Record<string, string>): string {
	const visibleTools = selectedTools.filter((name) => !!toolSnippets[name]);
	if (visibleTools.length === 0) return "(none)";

	return visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n");
}

function hasAnyFileTool(selectedTools: string[]): boolean {
	return ["grep", "find", "ls"].some((tool) => selectedTools.includes(tool));
}

function shellFileRule(selectedTools: string[]): string | undefined {
	const hasBash = selectedTools.includes("bash");
	const hasPowerShell = selectedTools.includes("powershell");

	const match = SHELL_FILE_RULES.find(
		(item) =>
			(!item.needsBash || hasBash) &&
			(!item.needsPowerShell || hasPowerShell) &&
			(item.needsBash === hasBash || item.needsPowerShell === hasPowerShell),
	);

	return match?.rule;
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

	if (!hasAnyFileTool(selectedTools)) {
		const rule = shellFileRule(selectedTools);
		if (rule) addRule(rule);
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
		[
			"Batch independent tool calls together; between batches, a line or two on",
			"what you are doing and why is welcome, narrating every step is not required",
		].join(" "),
	);
	addRule("Show file paths clearly when working with files");
	addRule(
		"Check live state (running processes, logs, installed vs source) before describing a system",
	);

	return rules.map((rule) => `- ${rule}`).join("\n");
}

function buildDocsSection(): string {
	const examples = getExamplesPath();

	return (
		`Gama documentation (read only when the user asks about gama itself, ` +
		`its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Examples: ${examples} (extensions, custom tools, SDK)
- When reading examples, resolve examples/... under Examples, not the current working directory`
	);
}

function pickSkillFileReadTool(selectedTools: string[]): "read" | "bash" | undefined {
	return (["read", "bash"] as const).find((tool) => selectedTools.includes(tool));
}

export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);

	for (const name of Object.keys(options.sections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid section: ${name}`);
		}
	}

	const promptSections = buildCoreSections(options);
	addExtraSections(promptSections, options);

	return wrapSections(promptSections);
}

function buildCoreSections(options: NormalizedBuildSystemPromptOptions): Record<string, string> {
	if (options.customPrompt) return { preamble: options.customPrompt };

	return {
		preamble: DEFAULT_PREAMBLE,
		tools: `${renderTools(options.selectedTools, options.toolSnippets)}\n\n${TOOLS_NOTE}`,
		working: WORKING_SECTION,
		rules: buildRules(options.selectedTools, options.toolGuidelines, options.promptGuidelines),
		docs: buildDocsSection(),
	};
}

function addExtraSections(
	promptSections: Record<string, string>,
	options: NormalizedBuildSystemPromptOptions,
): void {
	if (options.appendSystemPrompt) promptSections.addendum = options.appendSystemPrompt;

	if (options.contextFiles.length > 0) {
		promptSections.project_context = renderProjectContext(options.contextFiles);
	}

	const skillTool = pickSkillFileReadTool(options.selectedTools);
	if (skillTool && options.skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(options.skills, skillTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}

	promptSections.cwd = options.cwd.replace(/\\/g, "/");

	for (const [name, content] of Object.entries(options.sections)) {
		if (content) promptSections[name] = content;
	}
}

function wrapSections(promptSections: Record<string, string>): SystemPromptSections {
	const sections: SystemPromptSections = { preamble: promptSections.preamble };

	for (const [name, content] of Object.entries(promptSections)) {
		if (name === "preamble") continue;
		sections[name] = `<${name}>\n${content}\n</${name}>`;
	}

	return sections;
}
