import { getPowerShellConfig } from "../../utils/shell.ts";
import {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	buildShellTool,
	type createBashTool,
	createLocalShellOperations,
	createShellToolDefinition,
	type ShellToolConfig,
	sessionEnvGuideline,
} from "./bash.ts";

// UTF-8
const UTF8_OUTPUT_PREFIX =
	"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export type PowerShellOperations = BashOperations;

export type PowerShellSpawnContext = BashSpawnContext;

export type PowerShellSpawnHook = BashSpawnHook;

export type PowerShellToolDetails = BashToolDetails;

export type PowerShellToolInput = BashToolInput;

export type PowerShellToolOptions = Pick<
	BashToolOptions,
	"operations" | "exposeSessionEnvironment" | "spawnHook"
>;

export const powershellToolSystemPromptContribution = {
	snippet: "Execute PowerShell commands",
	guidelines: [sessionEnvGuideline],
} as const;

const powershellToolConfig: ShellToolConfig = {
	name: "powershell",
	label: "powershell",
	shellName: "PowerShell",
	prompt: "PS>",
	promptSnippet: powershellToolSystemPromptContribution.snippet,
	promptGuidelines: powershellToolSystemPromptContribution.guidelines,
	tempFilePrefix: "gama-powershell",
};

export function createLocalPowerShellOperations(): PowerShellOperations {
	const operations = createLocalShellOperations(getPowerShellConfig);

	return {
		exec: (command, cwd, options) =>
			operations.exec(`${UTF8_OUTPUT_PREFIX}${command}`, cwd, options),
	};
}

export function createPowerShellToolDefinition(
	cwd: string,
	options?: PowerShellToolOptions,
): ReturnType<typeof createShellToolDefinition> {
	return createShellToolDefinition(cwd, powershellToolConfig, {
		...options,
		operations: options?.operations ?? createLocalPowerShellOperations(),
	});
}

export function createPowerShellTool(
	cwd: string,
	options?: PowerShellToolOptions,
): ReturnType<typeof createBashTool> {
	return buildShellTool(createPowerShellToolDefinition(cwd, options));
}
