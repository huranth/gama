import type { SourceInfo } from "./origin.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "s", description: "Send while busy; alone makes it the default" },
	{ name: "q", description: "Queue until the run ends; alone makes it the default" },
	{ name: "model", description: "Switch to another model" },
	{ name: "history", description: "Browse and resume sessions from this folder" },
	{ name: "provider", description: "Edit base URL and key" },
	{ name: "context", description: "Show or set context window" },
	{ name: "reason", description: "Set reasoning effort level" },
	{ name: "compact", description: "Summarize the conversation to free context" },
	{ name: "bell", description: "Toggle the bell when a long run finishes" },
	{ name: "cache", description: "Show prompt cache stats" },
	{ name: "stats", description: "Show session and context stats" },
	{ name: "changelog", description: "Show release notes" },
	{ name: "update", description: "Install the available update" },
	{ name: "summaries", description: "Toggle summary canvases for long prompts" },
];
