import { copyJson, type Draft } from "@huranth/chord";
import { defineDoc } from "../documents.ts";
import type { ConversationId, ConversationRecord, Tx } from "../types.ts";
import type {
	Agent,
	AgentChange,
	AgentState,
	CompactionPolicy,
	ConversationRetryPolicy,
	Extension,
	HarnessSettings,
	PromptSection,
	RegistrySnapshot,
	Settings,
	ToolRegistration,
} from "./types.ts";

export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

export const INSTRUCTIONS_KEY = "instructions";

export const AgentDoc = defineDoc<AgentState>({
	kind: "gama.agent",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});

export async function configure(
	tx: Tx,
	conversationId: ConversationId,
	change: AgentChange,
): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	applyChange(state, change);
}

export function resolveSettings(settings: HarnessSettings | undefined): Settings {
	const extensions = settings?.extensions;

	return {
		...(extensions === undefined ? {} : { extensions }),
		stream: { ...settings?.stream },
		retry: { ...DEFAULT_RETRY_POLICY, ...settings?.retry },
		compaction: { ...DEFAULT_COMPACTION_POLICY, ...settings?.compaction },
		toolExecution: settings?.toolExecution ?? "parallel",
		steeringMode: settings?.steeringMode ?? "one-at-a-time",
		followUpMode: settings?.followUpMode ?? "one-at-a-time",
	};
}

export async function createAgent(tx: Tx, conversation: ConversationRecord): Promise<void> {
	if (conversation.parent !== undefined) {
		return;
	}

	const agent = await tx.doc(AgentDoc, conversation.id);
	if (conversation.owner === undefined) {
		return;
	}

	const owner = await tx.doc(AgentDoc, conversation.owner.conversationId);
	Object.assign(agent, copyJson(owner) as AgentState);
}

export function agentHooks(agent: Agent, taskName: string): object[] {
	const handlers: object[] = [];

	for (const extension of agent.extensions) {
		for (const hook of extension.hooks ?? []) {
			if (hook.task === taskName) {
				handlers.push(hook.handlers);
			}
		}
	}

	return handlers;
}

export async function addTools(
	tx: Tx,
	conversationId: ConversationId,
	added: readonly string[],
): Promise<void> {
	const state = await tx.doc(AgentDoc, conversationId);
	const tools = state.tools;
	if (tools === undefined) {
		return;
	}

	if (Array.isArray(tools)) {
		for (const name of added) {
			if (!tools.includes(name)) {
				tools.push(name);
			}
		}

		return;
	}

	const remove = (tools as { remove: string[] }).remove;
	const stillRemoved = remove.filter((name) => !added.includes(name));
	if (stillRemoved.length !== remove.length) {
		state.tools = { remove: stillRemoved };
	}
}

export function resolveAgent<Tool extends ToolRegistration>(
	state: Readonly<AgentState> | undefined,
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
	report: (error: unknown) => void,
): Agent<Tool> {
	const extensions = selectExtensions(state?.extensions, snapshot, settings);
	const composed = composeTools(extensions);
	const sections = composeSections(extensions);

	applyWraps(extensions, composed, sections, report);

	const tools = selectTools(state?.tools, composed);
	const agentSections = buildSections(sections, state?.instructions);
	const instructions = state?.instructions;

	const agent: Agent<Tool> = {
		...(state?.model === undefined ? {} : { model: state.model }),
		thinkingLevel: state?.thinkingLevel ?? "off",
		extensions,
		tools,
		sections: agentSections,
		...(instructions === undefined ? {} : { instructions }),
		...(state?.cwd === undefined ? {} : { cwd: state.cwd }),
	};

	return agent;
}

function isList<T>(value: readonly T[] | object): value is readonly T[] {
	return Array.isArray(value);
}

function names(items: readonly { readonly name: string }[]): string[] {
	return items.map((item) => item.name);
}

function setField<K extends keyof AgentState>(
	state: Draft<AgentState>,
	key: K,
	value: AgentState[K] | null | undefined,
): void {
	if (value === undefined) {
		return;
	}

	if (value === null) {
		delete state[key];
		return;
	}

	state[key] = value as Draft<AgentState>[K];
}

function toExtensions(
	extensions: AgentChange["extensions"],
): AgentState["extensions"] | null | undefined {
	if (extensions === undefined || extensions === null) {
		return extensions;
	}

	if (isList(extensions)) {
		return names(extensions);
	}

	const edit: { add?: string[]; remove?: string[] } = {};

	if (extensions.add !== undefined) {
		edit.add = names(extensions.add);
	}

	if (extensions.remove !== undefined) {
		edit.remove = names(extensions.remove);
	}

	return edit;
}

function toTools(tools: AgentChange["tools"]): AgentState["tools"] | null | undefined {
	if (tools === undefined || tools === null) {
		return tools;
	}

	if (isList(tools)) {
		return names(tools);
	}

	return { remove: names(tools.remove) };
}

function applyChange(state: Draft<AgentState>, change: AgentChange): void {
	const model = change.model;
	const nextModel = model === undefined || model === null ? model : { ...model };

	setField(state, "model", nextModel);
	setField(state, "thinkingLevel", change.thinkingLevel);
	setField(state, "extensions", toExtensions(change.extensions));
	setField(state, "tools", toTools(change.tools));
	setField(state, "instructions", change.instructions);
	setField(state, "cwd", change.cwd);
}

function applyWrap<T>(
	items: Map<string, T>,
	target: string,
	wrap: (item: T) => T,
	nameOf: (item: T) => string,
	report: (error: unknown) => void,
): void {
	const item = items.get(target);
	if (item === undefined) {
		return;
	}

	try {
		const wrapped = wrap(item);

		if (nameOf(wrapped) !== target) {
			throw new Error(`Wrapper renamed ${target} to ${nameOf(wrapped)}`);
		}

		items.set(target, wrapped);
	} catch (error) {
		items.delete(target);
		report(error);
	}
}

function applyWraps<Tool extends ToolRegistration>(
	extensions: Extension<Tool>[],
	composed: Map<string, Tool>,
	sections: Map<string, PromptSection<Tool>>,
	report: (error: unknown) => void,
): void {
	for (const extension of extensions) {
		for (const wrap of extension.wraps ?? []) {
			if ("tool" in wrap) {
				applyWrap(
					composed,
					wrap.tool,
					(tool) => wrap.wrap(tool),
					(tool) => tool.name,
					report,
				);
				continue;
			}

			applyWrap(
				sections,
				wrap.section,
				(section) => wrap.wrap(section),
				(section) => section.key,
				report,
			);
		}
	}
}

function composeTools<Tool extends ToolRegistration>(
	extensions: Extension<Tool>[],
): Map<string, Tool> {
	const composed = new Map<string, Tool>();

	for (const extension of extensions) {
		for (const tool of extension.tools ?? []) {
			composed.set(tool.name, tool);
		}
	}

	return composed;
}

function composeSections<Tool extends ToolRegistration>(
	extensions: Extension<Tool>[],
): Map<string, PromptSection<Tool>> {
	const sections = new Map<string, PromptSection<Tool>>();

	for (const extension of extensions) {
		for (const section of extension.sections ?? []) {
			sections.set(section.key, section);
		}
	}

	return sections;
}

function selectTools<Tool extends ToolRegistration>(
	filter: AgentState["tools"],
	composed: Map<string, Tool>,
): Tool[] {
	if (filter === undefined) {
		return [...composed.values()];
	}

	if (Array.isArray(filter)) {
		const tools: Tool[] = [];

		for (const name of new Set(filter)) {
			const tool = composed.get(name);

			if (tool !== undefined) {
				tools.push(tool);
			}
		}

		return tools;
	}

	const removed = new Set((filter as { remove: string[] }).remove);
	return [...composed.values()].filter((tool) => !removed.has(tool.name));
}

function buildSections<Tool extends ToolRegistration>(
	sections: Map<string, PromptSection<Tool>>,
	instructions: string | undefined,
): PromptSection<Tool>[] {
	const agentSections = [...sections.values()];

	if (instructions !== undefined) {
		agentSections.push({ key: INSTRUCTIONS_KEY, render: () => instructions });
	}

	return agentSections;
}

function selectExtensions<Tool extends ToolRegistration>(
	stored: AgentState["extensions"],
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
): Extension<Tool>[] {
	const selected = resolveExtensionNames(stored, snapshot, settings);
	const extensions: Extension<Tool>[] = [];

	for (const name of new Set(selected)) {
		const extension = snapshot.extension(name);

		if (extension !== undefined) {
			extensions.push(extension);
		}
	}

	return extensions;
}

function resolveExtensionNames<Tool extends ToolRegistration>(
	stored: AgentState["extensions"],
	snapshot: RegistrySnapshot<Tool>,
	settings: Settings,
): string[] {
	if (Array.isArray(stored)) {
		return stored;
	}

	const configured = settings.extensions?.map((extension) => extension.name);
	const installed = snapshot.installed().map((extension) => extension.name);
	const base = configured ?? installed;
	const edit = stored as { add?: string[]; remove?: string[] } | undefined;
	const removed = new Set(edit?.remove ?? []);
	const added = edit?.add ?? [];

	return [...base, ...added].filter((name) => !removed.has(name));
}
