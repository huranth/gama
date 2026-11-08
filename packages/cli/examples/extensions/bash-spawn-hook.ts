import type { ExtensionAPI } from "@huranth/gama-harness";
import { createBashTool } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, GAMA_SPAWN_HOOK: "1" },
		}),
	});

	gama.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
