import type { ExtensionAPI, ExtensionFactory } from "../../core/ext/types.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.ts";

export interface CodemodeExtensionOptions {
	mode?: CodemodeMode;
	inlineBudget?: number;
	models?: boolean;
}

function readMode(gama: ExtensionAPI): CodemodeMode {
	return gama.getSettings().codemode?.mode === "only" ? "only" : "on";
}

function readInlineBudget(gama: ExtensionAPI): number | undefined {
	const budget = gama.getSettings().codemode?.inlineBudget;
	return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
}

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (gama) => {
		gama.registerTool({
			...createCodemodeToolDefinition({
				appendEntry: (customType, data) => gama.appendEntry(customType, data),
				models: options.models ?? true,
				getToolNamespace: (name) =>
					gama.getAllTools().find((tool) => tool.name === name)?.namespace,
				getMode: () => options.mode ?? readMode(gama),
				getInlineBudget: () => options.inlineBudget ?? readInlineBudget(gama),
			}),
			defaultActive: false,
		});
	};
}

export default createCodemodeExtension();
