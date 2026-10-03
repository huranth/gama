import type { AgentTool } from "@huranth/gama-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@huranth/gama-codemode";
import {
	MCP_TYPESCRIPT_PREAMBLE,
	mcpStructuredContentSchema,
	renderToolOutputType,
	renderToolSample,
	toCodemodeIdentifier,
} from "@huranth/gama-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@huranth/gama-codemode/source";
import { type Static, Type } from "typebox";
import type {
	ToolDefinition,
	ToolInfo,
	ToolLoadout,
	ToolLoadoutChanges,
	ToolNamespace,
} from "../../core/ext/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
import { codemodeRenderers } from "./renderer.ts";

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

export type CodemodeModelRuntime = Pick<
	ModelRegistry,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;

export interface CodemodeToolOptions {
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	models?: boolean;
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
	getMode?: () => CodemodeMode;
	getInlineBudget?: () => number | undefined;
}

export type CodemodeToolInput = Static<typeof codemodeSchema>;

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface CodemodeNestedCall {
	id: string;
	name: string;
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	error?: string;
	cost?: number;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	fullOutputPath?: string;
}

export interface CodemodeDescriptionOptions {
	models?: boolean;
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	deferred?: ReadonlySet<string>;
	inlineBudget?: number;
}

interface CatalogEntry {
	name: string;
	section: string;
	cost: number;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

export const CODEMODE_TOOL_NAME = "codemode";

export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
	code: Type.String({
		description: "Raw JavaScript source.",
	}),
});

export function isCodemodeTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === CODEMODE_TOOL_NAME && tool.parameters === codemodeSchema;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools",
	guidelines: [
		"Use codemode to batch independent tool calls (Promise.allSettled), chain them, " +
			"or filter large output, instead of many separate calls.",
	],
} as const;

const DESCRIPTION_INTRO =
	`Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), ` +
	`run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. ` +
	`No Node, file system, network, or timers.\n` +
	`- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's ` +
	`declaration says so, and rejects with an Error on failure. Calls still running when the ` +
	`script ends are cancelled.\n` +
	`- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

function describeGlobals(models: boolean): string {
	const lines = [
		"Globals:",
		"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level " +
			"`return` add output; `exit()` ends the script.",
		"- `store(key, value)` and `load(key)` keep JSON values across codemode calls.",
		"- `ALL_TOOLS`, `searchTools(query, { limit?, namespace? })`, " +
			"`describeTool(name)`, `describeNamespace(name)`: find unlisted tools, " +
			"such as MCP tools.",
	];

	if (models) {
		lines.push("- `models`: classifiers and image generation.");
	}

	return lines.join("\n");
}

export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;

const CHARS_PER_TOKEN = 4;

export function toCodemodeDeclaration(tool: AgentTool<any>): Omit<CodemodeTool, "execute"> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

export function getCodemodeCallableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading =
		id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
	if (budget === undefined)
		return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

export function createCodemodeDescription(
	tools: readonly AgentTool<any>[],
	options: CodemodeDescriptionOptions = {},
): string {
	const declarations = getCodemodeCallableTools(tools)
		.filter((tool) => !options.deferred?.has(tool.name))
		.map(toCodemodeDeclaration);
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const declaration of declarations) {
		const namespace = options.namespaces?.get(declaration.name);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = renderToolSection(declaration);
		group.entries.push({
			name: declaration.name,
			section,
			cost: Math.ceil(section.length / CHARS_PER_TOKEN),
		});
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined
			? -1
			: b.namespace === undefined
				? 1
				: a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget);

	const sections = [DESCRIPTION_INTRO, describeGlobals(options.models === true)];
	if (
		declarations.some(
			(declaration) =>
				shown.has(declaration.name) &&
				mcpStructuredContentSchema(declaration.outputSchema) !== undefined,
		)
	) {
		sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	if (declarations.length === 0) return sections.join("\n\n");

	const toolSections = ["Nested tools:"];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = namespace.description?.trim();
			toolSections.push(
				`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`,
			);
		}
		for (const entry of visible) {
			toolSections.push(entry.section);
		}
	}
	sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

function describeOutput(schema: CodemodeJsonSchema | undefined): string {
	const type = renderToolOutputType(schema);
	if (type === "string") return "a string";
	const object = typeof schema === "object" ? schema : undefined;
	const properties = object?.properties;
	if (
		object?.type === "object" &&
		typeof properties === "object" &&
		properties !== null &&
		mcpStructuredContentSchema(schema) === undefined
	) {
		const required = new Set(Array.isArray(object.required) ? object.required : []);
		const fields = Object.keys(properties).map((name) =>
			required.has(name) ? name : `${name}?`,
		);
		return `\`{ ${fields.join(", ")} }\``;
	}
	return `\`${type.replace(/\s+/g, " ")}\``;
}

function describeScriptCall(tool: AgentTool<any>): string {
	const call = `tools.${toCodemodeIdentifier(tool.name)}(args)`;
	const output = describeOutput(toCodemodeDeclaration(tool).outputSchema);
	return `${tool.description.trim()}\n\nCodemode: \`${call}\` resolves to ${output}.`;
}

function prepareCodemodeLoadout(
	loadout: ToolLoadout,
	options: CodemodeToolOptions,
): ToolLoadoutChanges {
	const mode = options.getMode?.() ?? "on";
	const isDirect = (tool: AgentTool) => loadout.getExposure(tool.name) === "direct";
	const callable = getCodemodeCallableTools(loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name)) descriptions[tool.name] = describeScriptCall(tool);
		}
	}
	const listed = mode === "only" ? callable : callable.filter((tool) => !isDirect(tool));
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		models: options.models === true,
		namespaces,
		deferred: new Set(
			listed
				.filter((tool) => loadout.getExposure(tool.name) === "deferred")
				.map((tool) => tool.name),
		),
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
	return {
		descriptions,
		hiddenDeclarations:
			mode === "only"
				? callable
						.filter((tool) => isDirect(tool) && declaredNames.has(tool.name))
						.map((tool) => tool.name)
				: [],
	};
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		description: createCodemodeDescription([], { models: options.models === true }),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		exposure: "model-only",
		prepareLoadout: (loadout) => prepareCodemodeLoadout(loadout, options),
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
				options,
			),
		...codemodeRenderers,
	};
}

export function createCodemodeTool(
	tools: readonly AgentTool<any>[] = [],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools, { models: options.models === true }),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
