export const claudeCodeVersion = "2.1.280";

const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const toolLookup = new Map(claudeCodeTools.map((tool) => [tool.toLowerCase(), tool]));

export function toClaudeCodeName(name: string): string {
	return toolLookup.get(name.toLowerCase()) ?? name;
}
