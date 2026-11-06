import type { ExtensionFactory } from "../../core/ext/types.ts";
import { createToolSearchToolDefinition } from "./tool.ts";

export function createToolSearchExtension(): ExtensionFactory {
	return (gama) => {
		gama.registerTool({
			...createToolSearchToolDefinition({ tools: gama }),
			defaultActive: false,
		});
	};
}

export default createToolSearchExtension();
