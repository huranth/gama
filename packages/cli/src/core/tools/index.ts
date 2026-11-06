import type { AgentTool } from "@huranth/gama-agent-core";
import type { ToolDefinition } from "../ext/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import type { FileReadTracker } from "./file-read-tracker.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import {
	createOutlineTool,
	createOutlineToolDefinition,
	type OutlineToolOptions,
} from "./outline.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import {
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellToolOptions,
} from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWebFetchTool, createWebFetchToolDefinition } from "./webfetch.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;

export type ToolDef = ToolDefinition<any, any>;

export type ToolName =
	| "read"
	| "bash"
	| "powershell"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "outline"
	| "fetch";

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
	outline?: OutlineToolOptions;
}

// Tool groups
const CODING_TOOL_NAMES: ToolName[] = ["read", "bash", "edit", "write"];

const READ_ONLY_TOOL_NAMES: ToolName[] = ["read", "grep", "find", "ls", "outline", "fetch"];

const ALL_TOOL_NAMES: ToolName[] = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"outline",
	"fetch",
];

export const allToolNames: Set<ToolName> = new Set(ALL_TOOL_NAMES);

type DefinitionFn = (cwd: string, options?: ToolsOptions) => ToolDef;

type ToolFn = (cwd: string, options?: ToolsOptions) => Tool;

interface Factories {
	definition: DefinitionFn;
	tool: ToolFn;
}

function withTracker<T>(options: T | undefined, tracker: FileReadTracker | undefined): T {
	return { ...(options as T), tracker } as T;
}

function readOptions(options?: ToolsOptions): ReadToolOptions {
	return withTracker(options?.read, options?.files);
}

function editOptions(options?: ToolsOptions): EditToolOptions {
	return withTracker(options?.edit, options?.files);
}

function writeOptions(options?: ToolsOptions): WriteToolOptions {
	return withTracker(options?.write, options?.files);
}

const factories: Record<ToolName, Factories> = {
	read: {
		definition: (cwd, options) => createReadToolDefinition(cwd, readOptions(options)),
		tool: (cwd, options) => createReadTool(cwd, readOptions(options)),
	},
	bash: {
		definition: (cwd, options) => createBashToolDefinition(cwd, options?.bash),
		tool: (cwd, options) => createBashTool(cwd, options?.bash),
	},
	powershell: {
		definition: (cwd, options) => createPowerShellToolDefinition(cwd, options?.powershell),
		tool: (cwd, options) => createPowerShellTool(cwd, options?.powershell),
	},
	edit: {
		definition: (cwd, options) => createEditToolDefinition(cwd, editOptions(options)),
		tool: (cwd, options) => createEditTool(cwd, editOptions(options)),
	},
	write: {
		definition: (cwd, options) => createWriteToolDefinition(cwd, writeOptions(options)),
		tool: (cwd, options) => createWriteTool(cwd, writeOptions(options)),
	},
	grep: {
		definition: (cwd, options) => createGrepToolDefinition(cwd, options?.grep),
		tool: (cwd, options) => createGrepTool(cwd, options?.grep),
	},
	find: {
		definition: (cwd, options) => createFindToolDefinition(cwd, options?.find),
		tool: (cwd, options) => createFindTool(cwd, options?.find),
	},
	ls: {
		definition: (cwd, options) => createLsToolDefinition(cwd, options?.ls),
		tool: (cwd, options) => createLsTool(cwd, options?.ls),
	},
	outline: {
		definition: (cwd, options) => createOutlineToolDefinition(cwd, options?.outline),
		tool: (cwd, options) => createOutlineTool(cwd, options?.outline),
	},
	fetch: {
		definition: (cwd) => createWebFetchToolDefinition(cwd),
		tool: (cwd) => createWebFetchTool(cwd),
	},
};

function pick(toolName: ToolName): Factories {
	const entry = factories[toolName];
	if (!entry) throw new Error(`Unknown tool ${toolName}`);

	return entry;
}

function buildTools(names: ToolName[], cwd: string, options?: ToolsOptions): Tool[] {
	return names.map((name) => pick(name).tool(cwd, options));
}

function buildRecord<T>(
	names: ToolName[],
	cwd: string,
	options: ToolsOptions | undefined,
	build: (name: ToolName, cwd: string, options?: ToolsOptions) => T,
): Record<ToolName, T> {
	const record = {} as Record<ToolName, T>;
	for (const name of names) record[name] = build(name, cwd, options);

	return record;
}

export function createAllToolDefinitions(
	cwd: string,
	options?: ToolsOptions,
): Record<ToolName, ToolDef> {
	return buildRecord(ALL_TOOL_NAMES, cwd, options, (name, dir, opts) =>
		pick(name).definition(dir, opts),
	);
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return buildTools(CODING_TOOL_NAMES, cwd, options);
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return buildTools(READ_ONLY_TOOL_NAMES, cwd, options);
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return buildRecord(ALL_TOOL_NAMES, cwd, options, (name, dir, opts) => pick(name).tool(dir, opts));
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	return pick(toolName).tool(cwd, options);
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
	createOutlineTool,
	createOutlineToolDefinition,
	type OutlineEntry,
	type OutlineToolDetails,
	type OutlineToolInput,
	type OutlineToolOptions,
} from "./outline.ts";

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
	createWebFetchTool,
	createWebFetchToolDefinition,
	type WebFetchToolDetails,
	type WebFetchToolInput,
} from "./webfetch.ts";

export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";
