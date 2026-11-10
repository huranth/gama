import {
	builtinModels,
	getBuiltinModel,
	getBuiltinModels,
	getBuiltinProviders,
} from "./catalog/all.ts";
import {
	createFauxCore,
	type FauxProviderRegistration,
	type RegisterFauxProviderOptions,
} from "./catalog/faux.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type { ModelsApiStreamOptions } from "./registry.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	Context,
	Model,
	ProviderStreamOptions,
	ProviderStreams,
	ReplyStream,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
} from "./types.ts";
import { normalizeContext } from "./utils/transcript.ts";
import { anthropicMessagesApi } from "./wire/anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "./wire/azure-openai-responses.lazy.ts";
import { bedrockConverseStreamApi } from "./wire/bedrock-converse-stream.lazy.ts";
import { gamaMessagesApi } from "./wire/gama-messages.lazy.ts";
import { googleGenerativeAIApi } from "./wire/google-generative-ai.lazy.ts";
import { googleVertexApi } from "./wire/google-vertex.lazy.ts";
import { mistralConversationsApi } from "./wire/mistral-conversations.lazy.ts";
import { openAICodexResponsesApi } from "./wire/openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "./wire/openai-completions.lazy.ts";
import { openAIResponsesApi } from "./wire/openai-responses.lazy.ts";

export type { BuiltinProvider } from "./catalog/all.ts";
export * from "./env-api-keys.ts";
export * from "./images.ts";
export * from "./images-api-registry.ts";
export * from "./index.ts";
export * from "./legacy-api-aliases.ts";
export * from "./wire/anthropic-messages.lazy.ts";
export * from "./wire/azure-openai-responses.lazy.ts";
export * from "./wire/bedrock-converse-stream.lazy.ts";
export * from "./wire/gama-messages.lazy.ts";
export * from "./wire/google-generative-ai.lazy.ts";
export * from "./wire/google-vertex.lazy.ts";
export * from "./wire/mistral-conversations.lazy.ts";
export * from "./wire/openai-codex-responses.lazy.ts";
export * from "./wire/openai-completions.lazy.ts";
export * from "./wire/openai-responses.lazy.ts";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: StreamOptions,
) => ReplyStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => ReplyStream;

export interface ApiProvider<
	TApi extends Api = Api,
	TOptions extends StreamOptions = StreamOptions,
> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

export const getModel = getBuiltinModel;

export const getModels = getBuiltinModels;

export const getProviders = getBuiltinProviders;

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

const compatModels = builtinModels();

const AMBIENT_AUTH_MARKER = "<authenticated>";

function assertApiMatch(actual: Api, expected: Api): void {
	if (actual === expected) return;

	throw new Error(`API mismatch: ${actual}`);
}

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		assertApiMatch(model.api, api);

		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		assertApiMatch(model.api, api);

		return streamSimple(model as Model<TApi>, context, options);
	};
}

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry) {
		if (entry.sourceId !== sourceId) continue;

		apiProviderRegistry.delete(api);
	}
}

function clearApiProviders(): void {
	apiProviderRegistry.clear();
}

export function registerFauxProvider(
	options: RegisterFauxProviderOptions = {},
): FauxProviderRegistration {
	const core = createFauxCore(options);
	const sourceId = `faux-provider-${Math.random().toString(36).slice(2, 10)}`;
	registerApiProvider(
		{ api: core.api, stream: core.stream, streamSimple: core.streamSimple },
		sourceId,
	);

	return {
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
		unregister() {
			unregisterApiProviders(sourceId);
		},
	};
}

const BUILTIN_APIS: [Api, ProviderStreams][] = [
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["mistral-conversations", mistralConversationsApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
	["gama-messages", gamaMessagesApi()],
];

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

const builtinApiProviderInstances = new Map<Api, ReturnType<typeof getApiProvider>>();

export function registerBuiltInApiProviders(): void {
	for (const [api, streams] of BUILTIN_APIS) {
		if (!getApiProvider(api)) {
			registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
		}
		builtinApiProviderInstances.set(api, getApiProvider(api));
	}
}

export function resetApiProviders(): void {
	clearApiProviders();
	builtinApiProviderInstances.clear();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;

	const apiKey = getEnvApiKey(model.provider, options?.env);
	if (!apiKey || apiKey === AMBIENT_AUTH_MARKER) return options;

	return { ...options, apiKey } as TOptions;
}

function hasResolvedCloudflareAuth(options: StreamOptions | undefined): boolean {
	return (
		hasExplicitApiKey(options?.apiKey) ||
		typeof options?.headers?.["cf-aig-authorization"] === "string"
	);
}

function getBuiltinProviderForModel(model: Model<Api>) {
	const builtin = builtinApiProviderInstances.get(model.api);
	if (getApiProvider(model.api) !== builtin) return undefined;

	const provider = compatModels.getProvider(model.provider);
	if (!provider) return undefined;

	const matches = provider.getModels().some((candidate) => candidate.api === model.api);

	return matches ? provider : undefined;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);

	if (!provider) {
		throw new Error(`No API provider: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): ReplyStream {
	const transcript = normalizeContext(context);
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			return compatModels.stream(
				model,
				transcript,
				options as ModelsApiStreamOptions<TApi> | undefined,
			);
		}
		return builtinProvider.stream(
			model,
			transcript,
			withEnvApiKey(model, options) as ApiStreamOptions<TApi> | undefined,
		);
	}
	const provider = resolveApiProvider(model.api);
	return provider.stream(
		model,
		transcript,
		withEnvApiKey(model, options) as ApiStreamOptions<TApi> | undefined,
	);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	return stream(model, context, options).result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): ReplyStream {
	const transcript = normalizeContext(context);
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			return compatModels.streamSimple(model, transcript, options);
		}
		return builtinProvider.streamSimple(model, transcript, withEnvApiKey(model, options));
	}
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, transcript, withEnvApiKey(model, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return streamSimple(model, context, options).result();
}
