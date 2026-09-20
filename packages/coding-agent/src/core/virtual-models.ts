import type { AgentMessage } from "@huranth/gama-agent-core";
import {
	type AnyModel,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	isModelType,
	lazyStream,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type ThinkingLevelMap,
} from "@huranth/gama-ai";
import type { SessionEntry } from "./session-manager.ts";

export interface VirtualModelStateData<TState = unknown> {
	provider: string;
	modelId: string;
	state: TState;
}

export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";

export interface ModelRouteRequest<TState = unknown> {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	reason: ModelRouteReason;
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel };
	failed?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	state?: TState;
	messages: readonly Message[];
	signal?: AbortSignal;
}

export interface ModelRoute<TState = unknown> {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	state?: TState;
}

export interface VirtualModelDefinition<TState = unknown> {
	provider: string;
	id: string;
	name: string;
	thinkingLevels?: readonly ModelThinkingLevel[];
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	route(request: ModelRouteRequest<TState>): ModelRoute<TState> | Promise<ModelRoute<TState>>;
}

export const VIRTUAL_MODEL_API = "gama-virtual";

export const VIRTUAL_MODEL_STATE_ENTRY = "gama.virtual-model-state";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function isVirtualModel(model: { api: string }): boolean {
	return model.api === VIRTUAL_MODEL_API;
}

function unroutedStream(model: Model<Api>): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		throw new Error(
			`Virtual model ${model.provider}/${model.id} must be routed before streaming`,
		);
	});
}

function findLastModelChange(
	branch: readonly SessionEntry[],
	before: number,
): { provider: string; modelId: string } | undefined {
	for (let i = before - 1; i >= 0; i--) {
		const entry = branch[i];

		if (entry.type === "model_change") {
			return { provider: entry.provider, modelId: entry.modelId };
		}
	}

	return undefined;
}

export function findLatestResponse(
	messages: readonly AgentMessage[],
): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];

		if (message.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;

		return message;
	}

	return undefined;
}

export function createVirtualModel(definition: Omit<VirtualModelDefinition, "route">): Model<Api> {
	const levels = definition.thinkingLevels ?? ["off"];
	const thinkingLevelMap: ThinkingLevelMap = {};

	for (const level of THINKING_LEVELS) {
		thinkingLevelMap[level] = levels.includes(level) ? level : null;
	}

	return {
		id: definition.id,
		name: definition.name,
		api: VIRTUAL_MODEL_API,
		provider: definition.provider,
		baseUrl: "",
		reasoning: levels.some((level) => level !== "off"),
		thinkingLevelMap,
		input: definition.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 0,
		maxTokens: definition.maxTokens ?? 0,
	};
}

export function withVirtualModels(
	providerId: string,
	provider: Provider | undefined,
	virtualModels: readonly Model<Api>[],
): Provider {
	if (!provider) {
		return {
			id: providerId,
			name: providerId,
			auth: {
				apiKey: {
					name: "Virtual model",
					resolve: async () => ({ auth: {}, source: "virtual" }),
				},
			},
			getModels: () => virtualModels,
			stream: unroutedStream,
			streamSimple: unroutedStream,
		};
	}
	const ids = new Set(virtualModels.map((model) => model.id));

	const isPhysical = (model: AnyModel): boolean => {
		if (isVirtualModel(model)) return false;
		return !(isModelType(model, "chat") && ids.has(model.id));
	};

	const physical = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter(isPhysical);

	const virtual = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter((model) => isVirtualModel(model));

	const { filterModels, filterAllModels } = provider;

	return {
		...provider,
		getModels: () => [...physical(provider.getModels()), ...virtualModels],
		getAllModels: () => [
			...physical(provider.getAllModels?.() ?? provider.getModels()),
			...virtualModels,
		],
		filterModels: (models, credential) => {
			const real = physical(models);
			return [...(filterModels?.(real, credential) ?? real), ...virtual(models)];
		},
		filterAllModels: filterAllModels
			? (models, credential) => [
					...filterAllModels(physical(models), credential),
					...virtual(models),
				]
			: undefined,
		stream: (model, context, options) => {
			if (isVirtualModel(model)) return unroutedStream(model);

			return provider.stream(model, context, options);
		},
		streamSimple: (model, context, options) => {
			if (isVirtualModel(model)) return unroutedStream(model);

			return provider.streamSimple(model, context, options);
		},
	};
}

export function getVirtualModelState(
	branch: readonly SessionEntry[],
	provider: string,
	modelId: string,
): unknown {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];

		if (entry.type !== "custom") continue;
		if (entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;

		const data = entry.data as VirtualModelStateData | undefined;
		if (data?.provider === provider && data.modelId === modelId) return data.state;
	}

	return undefined;
}

export function getBranchSelection(
	branch: readonly SessionEntry[],
	getModel: (provider: string, modelId: string) => Model<Api> | undefined,
): { provider: string; modelId: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];

		if (entry.type === "model_change") {
			return { provider: entry.provider, modelId: entry.modelId };
		}

		if (entry.type !== "message") continue;
		if (entry.message.role !== "assistant") continue;
		if (isVirtualModel(entry.message)) continue;

		const response = { provider: entry.message.provider, modelId: entry.message.model };
		const change = findLastModelChange(branch, i);
		const model = change && getModel(change.provider, change.modelId);

		return change && model && isVirtualModel(model) ? change : response;
	}

	return undefined;
}
