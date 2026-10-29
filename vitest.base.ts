import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/bus/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/bus/src/scope/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/bus/src/patch/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/bus/src/bundler.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/bus/src/host.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/trace/src/index.ts", import.meta.url)),
	telemetryProbe: fileURLToPath(new URL("./packages/trace/src/probe/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/model/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/model/src/compat.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/model/src/wire", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/model/src/catalog", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/model/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/loop/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/script/src/index.ts", import.meta.url)),
	codemodeTypes: fileURLToPath(new URL("./packages/script/src/types.ts", import.meta.url)),
	codemodeTools: fileURLToPath(new URL("./packages/script/src/tools.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/script/src/types.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/script/src/tools.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/ui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@huranth\/gama-bus$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@huranth\/gama-bus\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@huranth\/gama-bus\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@huranth\/gama-bus\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
			{ find: /^@huranth\/gama-bus\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@huranth\/gama-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{
				find: /^@huranth\/gama-telemetry\/testing$/,
				replacement: workspaceSourcePaths.telemetryProbe,
			},
			{ find: /^@huranth\/gama-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@huranth\/gama-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{
				find: /^@huranth\/gama-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@huranth\/gama-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@huranth\/gama-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@huranth\/gama-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@huranth\/gama-codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^@huranth\/gama-codemode\/types$/, replacement: workspaceSourcePaths.codemodeTypes },
			{ find: /^@huranth\/gama-codemode\/tools$/, replacement: workspaceSourcePaths.codemodeTools },
			{
				find: /^@huranth\/gama-codemode\/declarations$/,
				replacement: workspaceSourcePaths.codemodeDeclarations,
			},
			{ find: /^@huranth\/gama-codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^@huranth\/gama-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
