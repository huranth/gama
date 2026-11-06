import type { AgentTool } from "@huranth/gama-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "../ext/types.ts";

export type ToolContextFactory = (
	toolCallId: string,
	signal: AbortSignal | undefined,
) => ExtensionToolContext;

export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: ToolContextFactory,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		outputSchema: definition.outputSchema,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,

		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionToolContext) => {
			// Optional ctx
			const resolved: ExtensionToolContext | undefined = ctx ?? ctxFactory?.(toolCallId, signal);

			return definition.execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				resolved as ExtensionToolContext,
			);
		},
	};
}

export function createToolDefinitionFromAgentTool(
	tool: AgentTool<any>,
): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		outputSchema: tool.outputSchema,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,

		execute: async (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params, signal, onUpdate),
	};
}
