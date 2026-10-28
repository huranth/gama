import type { AgentTool } from "@huranth/gama-agent-core";
import type { ToolDefinition } from "../ext/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import {
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellToolOptions,
} from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;

export type ToolDef = ToolDefinition<any, any>;

export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";

export interface ToolsOptions {
	files?: FileReadTracker;
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFileReadTracker,
	type FileReadTracker,
	READ_BEFORE_CHANGE_MESSAGE,
} from "./file-read-tracker.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

function readOptions(options?: ToolsOptions): ReadToolOptions {
	return { ...options?.read, tracker: options?.files };
}

function editOptions(options?: ToolsOptions): EditToolOptions {
	return { ...options?.edit, tracker: options?.files };
}

function writeOptions(options?: ToolsOptions): WriteToolOptions {
	return { ...options?.write, tracker: options?.files };
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, readOptions(options)),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, editOptions(options)),
		createWriteToolDefinition(cwd, writeOptions(options)),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, readOptions(options)),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, editOptions(options)),
		createWriteTool(cwd, writeOptions(options)),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(
	cwd: string,
	options?: ToolsOptions,
): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, readOptions(options)),
		bash: createBashToolDefinition(cwd, options?.bash),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, editOptions(options)),
		write: createWriteToolDefinition(cwd, writeOptions(options)),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, readOptions(options)),
		bash: createBashTool(cwd, options?.bash),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, editOptions(options)),
		write: createWriteTool(cwd, writeOptions(options)),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
	};
}

export function createToolDefinition(
	toolName: ToolName,
	cwd: string,
	options?: ToolsOptions,
): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, readOptions(options));
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, editOptions(options));
		case "write":
			return createWriteToolDefinition(cwd, writeOptions(options));
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, readOptions(options));
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, editOptions(options));
		case "write":
			return createWriteTool(cwd, writeOptions(options));
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		default:
			throw new Error(`Unknown tool ${toolName}`);
	}
}
