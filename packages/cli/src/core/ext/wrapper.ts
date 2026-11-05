import type { AgentTool } from "@huranth/gama-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { PluginHost } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

export function wrapRegisteredTool(
	registeredTool: RegisteredTool,
	runner: PluginHost,
): AgentTool {
	return wrapToolDefinition(registeredTool.definition, (toolCallId, signal) =>
		runner.createToolContext(toolCallId, signal),
	);
}

export function wrapRegisteredTools(
	registeredTools: RegisteredTool[],
	runner: PluginHost,
): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
