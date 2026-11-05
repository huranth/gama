import type { AgentTool } from "@huranth/gama-agent-core";
import {
	type PluginHost,
	type ToolDefinition,
	type ToolExposure,
	type ToolLoadout,
	wrapRegisteredTools,
} from "../ext/index.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, type SourceInfo } from "../origin.ts";
import { normalizePromptGuidelines, normalizePromptSnippet } from "./prompt.ts";

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export interface ToolErrorContext {
	extensionPath: string;
	event: string;
	error: string;
	stack?: string;
}

export interface ToolLoadoutContext {
	registry: Map<string, AgentTool>;
	definitions: Map<string, ToolDefinitionEntry>;
	emitError(error: ToolErrorContext): void;
}

export function getToolExposure(
	definitions: Map<string, ToolDefinitionEntry>,
	name: string,
): ToolExposure {
	return definitions.get(name)?.definition.exposure ?? "direct";
}

export function isToolDeclarable(exposure: ToolExposure): boolean {
	return exposure === "direct" || exposure === "model-only";
}

export function isToolActivatedOnRegistration(
	definitions: Map<string, ToolDefinitionEntry>,
	name: string,
): boolean {
	const definition = definitions.get(name)?.definition;
	return (
		isToolDeclarable(getToolExposure(definitions, name)) && definition?.defaultActive !== false
	);
}

export function getCallableTools(
	registry: Map<string, AgentTool>,
	definitions: Map<string, ToolDefinitionEntry>,
	active: ReadonlySet<string>,
): AgentTool[] {
	return [...registry.values()].filter((tool) => {
		const exposure = getToolExposure(definitions, tool.name);
		return (
			exposure === "codemode" ||
			exposure === "deferred" ||
			(exposure === "direct" && active.has(tool.name))
		);
	});
}

export function applyToolLoadout(
	context: ToolLoadoutContext,
	toolNames: string[],
): { declared: AgentTool[]; hidden: Set<string> } {
	const tools = [...new Set(toolNames)].flatMap((name) => {
		const tool = context.registry.get(name);
		return tool && getToolExposure(context.definitions, name) !== "hidden" ? [tool] : [];
	});
	const hooks = tools.flatMap((tool) => {
		const entry = context.definitions.get(tool.name);
		return entry?.definition.prepareLoadout ? [entry] : [];
	});
	const hidden = new Set<string>();
	let declared = tools;

	if (hooks.length > 0) {
		const loadout: ToolLoadout = {
			declared: tools,
			callable: getCallableTools(
				context.registry,
				context.definitions,
				new Set(tools.map((tool) => tool.name)),
			),
			registered: [...context.registry.values()],
			getExposure: (name) => getToolExposure(context.definitions, name),
			getNamespace: (name) => context.definitions.get(name)?.definition.namespace,
		};
		const descriptions = new Map<string, string>();

		for (const { definition, sourceInfo } of hooks) {
			try {
				const changes = definition.prepareLoadout?.(loadout);
				for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
					descriptions.set(name, description);
				}
				for (const name of changes?.hiddenDeclarations ?? []) {
					hidden.add(name);
				}
			} catch (error) {
				context.emitError({
					extensionPath: sourceInfo.path,
					event: "prepare_loadout",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}

		declared = tools.map((tool) => {
			const description = descriptions.get(tool.name);
			return description === undefined ? tool : { ...tool, description };
		});
	}

	return { declared, hidden };
}

export interface ToolRegistryBuildContext {
	baseToolDefinitions: Map<string, ToolDefinition>;
	customTools: ToolDefinition[];
	extensionRunner: PluginHost;
	isAllowedTool(name: string): boolean;
}

export interface ToolRegistryBuildResult {
	definitions: Map<string, ToolDefinitionEntry>;
	snippets: Map<string, string>;
	guidelines: Map<string, string[]>;
	registry: Map<string, AgentTool>;
	extensionTools: AgentTool[];
}

export function buildToolRegistry(context: ToolRegistryBuildContext): ToolRegistryBuildResult {
	const registeredTools = context.extensionRunner.getAllRegisteredTools();
	const customTools = [
		...registeredTools,
		...context.customTools.map((definition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
		})),
	].filter((tool) => context.isAllowedTool(tool.definition.name));

	const definitions = new Map<string, ToolDefinitionEntry>(
		Array.from(context.baseToolDefinitions.entries())
			.filter(([name]) => context.isAllowedTool(name))
			.map(([name, definition]) => [
				name,
				{
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, {
						source: "builtin",
					}),
				},
			]),
	);
	for (const tool of customTools) {
		definitions.set(tool.definition.name, {
			definition: tool.definition,
			sourceInfo: tool.sourceInfo,
		});
	}

	const snippets = new Map<string, string>(
		Array.from(definitions.values())
			.map(({ definition }) => {
				const snippet = normalizePromptSnippet(definition.promptSnippet);
				return snippet ? ([definition.name, snippet] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string] => entry !== undefined),
	);
	const guidelines = new Map<string, string[]>(
		Array.from(definitions.values())
			.map(({ definition }) => {
				const items = normalizePromptGuidelines(definition.promptGuidelines);
				return items.length > 0 ? ([definition.name, items] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
	);

	const extensionTools = wrapRegisteredTools(customTools, context.extensionRunner);
	const builtInTools = wrapRegisteredTools(
		Array.from(context.baseToolDefinitions.values())
			.filter((definition) => context.isAllowedTool(definition.name))
			.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
					source: "builtin",
				}),
			})),
		context.extensionRunner,
	);
	const registry = new Map(builtInTools.map((tool) => [tool.name, tool]));
	for (const tool of extensionTools as AgentTool[]) {
		registry.set(tool.name, tool);
	}

	return {
		definitions,
		snippets,
		guidelines,
		registry,
		extensionTools: extensionTools as AgentTool[],
	};
}
