import type { ToolRenderers } from "../../ext/types.ts";
import type { ToolName } from "../index.ts";
import { createShellRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { findRenderers } from "./find.ts";
import { grepRenderers } from "./grep.ts";
import { outlineRenderers } from "./outline.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import { webfetchRenderers } from "./web.ts";
import { writeRenderers } from "./write.ts";

export type { ToolRenderers };

export {
	createShellRenderers,
	editRenderers,
	findRenderers,
	grepRenderers,
	outlineRenderers,
	lsRenderers,
	readRenderers,
	webfetchRenderers,
	writeRenderers,
};

export function createAllToolRenderers(): Record<ToolName, ToolRenderers> {
	return {
		read: readRenderers,
		bash: createShellRenderers("$"),
		powershell: createShellRenderers("PS>"),
		edit: editRenderers,
		write: writeRenderers,
		grep: grepRenderers,
		find: findRenderers,
		ls: lsRenderers,
		outline: outlineRenderers,
		fetch: webfetchRenderers,
	};
}

const ALL_RENDERERS = createAllToolRenderers();

export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	const builtIn = ALL_RENDERERS[toolName as ToolName];
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
