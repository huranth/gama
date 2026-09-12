import type { JsonValue } from "@huranth/chord";
import type { TSchema } from "@huranth/gama-ai";
import type {
	AnyTask,
	Extension,
	HookRegistration,
	HooksOf,
	PromptSection,
	ToolRegistration,
	Wrap,
} from "./types.ts";

export function defineExtension<Tool extends ToolRegistration = ToolRegistration>(
	extension: Extension<Tool>,
): Extension<Tool> {
	return extension;
}

export function defineTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
): ToolRegistration<TParameters, TDetails> {
	return tool;
}

export function section<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	render: PromptSection<Tool>["render"],
	options?: { readonly tag?: boolean },
): PromptSection<Tool> {
	return options?.tag === undefined ? { key, render } : { key, render, tag: options.tag };
}

export function hook<K extends AnyTask>(task: K, handlers: Partial<HooksOf<K>>): HookRegistration {
	return { task: task.definition.name, handlers };
}

export function wrapTool<Tool extends ToolRegistration>(
	tool: Tool,
	wrapper: (tool: Tool) => Tool,
): Wrap<Tool> {
	return { tool: tool.name, wrap: wrapper };
}

export function wrapSection<Tool extends ToolRegistration = ToolRegistration>(
	key: string,
	wrapper: (section: PromptSection<Tool>) => PromptSection<Tool>,
): Wrap<Tool> {
	return { section: key, wrap: wrapper };
}
