import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/chord/src/bundler.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(
		new URL("./packages/telemetry/src/testing/index.ts", import.meta.url),
	),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(
		new URL("./packages/codemode/src/declarations.ts", import.meta.url),
	),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@huranth\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@huranth\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@huranth\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@huranth\/chord\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
			{ find: /^@huranth\/chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@huranth\/gama-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{
				find: /^@huranth\/gama-telemetry\/testing$/,
				replacement: workspaceSourcePaths.telemetryTesting,
			},
			{ find: /^@huranth\/gama-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@huranth\/gama-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@huranth\/gama-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
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
			{
				find: /^@huranth\/gama-codemode\/declarations$/,
				replacement: workspaceSourcePaths.codemodeDeclarations,
			},
			{ find: /^@huranth\/gama-codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^@huranth\/gama-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
