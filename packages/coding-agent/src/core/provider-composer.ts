import {
	type AnyModel,
	type Api,
	type ApiKeyAuth,
	type AssistantMessageEventStream,
	type AuthContext,
	type AuthInteraction,
	type AuthResult,
	type ClassifierApi,
	type Credential,
	type ImageApi,
	isModelType,
	lazyStream,
	type Model,
	type ModelAuth,
	type Provider,
	type ProviderClassifier,
	type ProviderHeaders,
	type ProviderImages,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@huranth/gama-ai";
import { getApiProvider } from "@huranth/gama-ai/compat";
import { classifierErrorResult, imageErrorResult } from "@huranth/gama-ai/utils/model-operations";
import { fetchEndpointModels, NO_PRICE, resolveModels } from "./custom-provider.ts";
import type {
	ModelConfig,
	ModelsJsonModel,
	ModelsJsonModelOverride,
	ModelsJsonProvider,
} from "./model-config.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

interface ProviderModelConfigBase {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	input: ("text" | "image")[];
	inputLimits?: AnyModel["inputLimits"];
	cost: AnyModel["cost"];
	headers?: Record<string, string>;
}

export interface ProviderChatModelConfig extends ProviderModelConfigBase {
	type?: "chat";
	api?: Api;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	promptCache?: Model<Api>["promptCache"];
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	compat?: Model<Api>["compat"];
}

export interface ProviderImageModelConfig extends ProviderModelConfigBase {
	type: "image";
	api?: ImageApi;
	output: ("text" | "image")[];
}

export interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	type: "classifier";
	api?: ClassifierApi;
	contextWindow: number;
}

export type ProviderModelConfig =
	| ProviderChatModelConfig
	| ProviderImageModelConfig
	| ProviderClassifierModelConfig;

export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	images?: Partial<Record<ImageApi, ProviderImages>>;
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: ProviderModelConfig[];
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
}

export type AuthStatus = {
	configured: boolean;
	source?:
		| "stored"
		| "runtime"
		| "environment"
		| "fallback"
		| "models_json_key"
		| "models_json_command";
	label?: string;
};

export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

export const clearApiKeyCache = clearConfigValueCache;

function getAllProviderModels(provider: Provider | undefined): readonly AnyModel[] {
	return provider ? (provider.getAllModels?.() ?? provider.getModels()) : [];
}

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of [
		"openRouterRouting",
		"vercelGatewayRouting",
		"chatTemplateKwargs",
		"chatTemplateArgs",
	] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = {
				...(baseValue as object | undefined),
				...(overrideValue as object | undefined),
			};
		}
	}
	return merged;
}

function mergeInputLimits(
	base: Model<Api>["inputLimits"],
	override: ModelsJsonModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? {
					...base?.images,
					...override.images,
					resize: override.images.resize
						? { ...base?.images?.resize, ...override.images.resize }
						: base?.images?.resize,
				}
			: base?.images,
	};
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		promptCache: override.promptCache
			? { ...model.promptCache, ...override.promptCache }
			: model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): Model<Api> {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. ` +
				"Set at provider or model level.",
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	}

	if (definition.contextWindow !== undefined && definition.contextWindow < 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}

	if (definition.maxTokens !== undefined && definition.maxTokens < 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}

	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? NO_PRICE,
		promptCache: definition.promptCache,
		// Defaults.
		contextWindow: definition.contextWindow || 128000,
		maxTokens: definition.maxTokens || 16384,
		samplingParams: definition.samplingParams,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

function findModelDefaults(
	models: readonly AnyModel[],
	modelId: string,
	api?: Api,
): Model<Api> | undefined {
	const chatModels = models.filter((model) => isModelType(model, "chat"));

	const byId = chatModels.find((model) => model.id === modelId);
	if (byId) {
		return byId;
	}

	const byApi = api ? chatModels.find((model) => model.api === api) : undefined;
	if (byApi) {
		return byApi;
	}

	const byDefaultApi = chatModels.find((model) => model.api === "openai-completions");
	if (byDefaultApi) {
		return byDefaultApi;
	}

	return chatModels[0];
}

function findExtensionModelDefaults(
	models: readonly AnyModel[],
	definition: ProviderModelConfig,
): AnyModel | undefined {
	const type = definition.type ?? "chat";
	const candidates = models.filter((model) => isModelType(model, type));

	const byId = candidates.find((model) => model.id === definition.id);
	if (byId) {
		return byId;
	}

	const byApi = definition.api
		? candidates.find((model) => model.api === definition.api)
		: undefined;
	if (byApi) {
		return byApi;
	}

	if (type === "chat") {
		const byDefaultApi = candidates.find((model) => model.api === "openai-completions");
		if (byDefaultApi) {
			return byDefaultApi;
		}
	}

	return candidates[0];
}

function extensionModelFromDefinition(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput,
	definition: ProviderModelConfig,
): AnyModel {
	const type = definition.type ?? "chat";
	const defaults = findExtensionModelDefaults(models, definition);
	const api = definition.api ?? (type === "chat" ? config.api : undefined) ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. ` +
				`Set it at model level${type === "chat" ? " or provider level" : ""}.`,
		);
	}
	const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	}

	if (definition.type === "image") {
		return {
			...definition,
			api: api as ImageApi,
			provider: providerId,
			baseUrl,
			headers: undefined,
		};
	}
	if (definition.type === "classifier") {
		return {
			...definition,
			api: api as ClassifierApi,
			provider: providerId,
			baseUrl,
			headers: undefined,
		};
	}
	return { ...definition, api: api as Api, provider: providerId, baseUrl, headers: undefined };
}

function applyModelsJson(
	providerId: string,
	baseModels: readonly AnyModel[],
	config: ModelsJsonProvider | undefined,
	onWarning?: (warning: string) => void,
): AnyModel[] {
	if (!config) {
		return [...baseModels];
	}

	const modelOverrides = config.modelOverrides;
	const hasOverrides = modelOverrides !== undefined && Object.keys(modelOverrides).length > 0;
	const hasModels = Boolean(config.models?.length);
	const hasBaseUrl = Boolean(config.baseUrl);
	const hasHeaders = Boolean(config.headers);
	const hasCompat = Boolean(config.compat);
	const hasApiKey = Boolean(config.apiKey);

	if (!hasModels && !hasBaseUrl && !hasHeaders && !hasCompat && !hasOverrides) {
		if (!hasApiKey && config.authHeader === undefined) {
			throw new Error(
				`Provider ${providerId}: must specify "baseUrl", "headers", "compat", ` +
					'"modelOverrides", or "models".',
			);
		}
	}

	const models: AnyModel[] = baseModels.map((model) => {
		const baseUrl = config.baseUrl ?? model.baseUrl;
		return isModelType(model, "chat")
			? { ...model, baseUrl, compat: mergeCompat(model.compat, config.compat) }
			: { ...model, baseUrl };
	});
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex(
			(model) => isModelType(model, "chat") && model.id === definition.id,
		);
		const defaults = findModelDefaults(models, definition.id, definition.api ?? config.api);
		let model: Model<Api>;

		try {
			model = modelFromJson(providerId, definition, config, defaults);
		} catch (error) {
			// Skip broken
			const reason = error instanceof Error ? error.message : String(error);
			onWarning?.(`skipping model ${definition.id}: ${reason}`);
			continue;
		}

		if (existingIndex >= 0) {
			models[existingIndex] = model;
		} else {
			models.push(model);
		}
	}
	return models;
}

function applyExtension(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput | undefined,
): AnyModel[] {
	if (!config) {
		return [...models];
	}

	if (!config.models) {
		const baseUrl = config.baseUrl;

		if (!baseUrl) {
			return [...models];
		}

		return models.map((model) => ({ ...model, baseUrl }));
	}

	return config.models.map((definition) =>
		extensionModelFromDefinition(providerId, models, config, definition),
	);
}

function withConfiguredAuth(
	auth: ModelAuth,
	headers: Record<string, string> | undefined,
	authHeader: boolean,
): ModelAuth {
	const hasHeaders = Boolean(auth.headers || headers);
	let mergedHeaders: ProviderHeaders | undefined = hasHeaders
		? { ...auth.headers, ...headers }
		: undefined;

	if (authHeader) {
		if (!auth.apiKey) {
			throw new Error("authHeader requires a resolved API key");
		}

		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}

	return { ...auth, headers: mergedHeaders };
}

function configuredApiKey(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): string | undefined {
	return extension?.apiKey ?? config?.apiKey;
}

function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	if (!config?.headers && !extension?.headers) {
		return undefined;
	}

	return { ...config?.headers, ...extension?.headers };
}

async function configContextEnv(
	values: readonly string[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };

	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) {
			continue;
		}

		const value = await ctx.env(name);
		if (value !== undefined) {
			env[name] = value;
		}
	}

	return Object.keys(env).length > 0 ? env : undefined;
}

function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey = configuredApiKey(config, extension);
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		name: inherited?.name ?? "API key",
		login:
			inherited?.login ??
			(async (interaction: AuthInteraction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
			})),
		check: async (input) => {
			if (input.credential) {
				if (inherited?.check) return inherited.check(input);
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				const resolved = await inherited?.resolve(input);
				return resolved ? { type: "api_key", source: resolved.source } : undefined;
			}
			if (rawKey !== undefined) {
				if (isCommandConfigValue(rawKey)) {
					return { type: "api_key", source: "configured API key" };
				}

				const envNames = getConfigValueEnvVarNames(rawKey);
				for (const name of envNames) {
					if ((await input.ctx.env(name)) === undefined) return undefined;
				}

				return { type: "api_key", source: "configured API key" };
			}
			if (inherited?.check) return inherited.check(input);
			const resolved = await inherited?.resolve(input);
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		resolve: async (input) => {
			let result: AuthResult | undefined;
			if (input.credential) {
				result = inherited
					? await inherited.resolve(input)
					: input.credential.key
						? {
								auth: { apiKey: input.credential.key },
								env: input.credential.env,
								source: "stored credential",
							}
						: undefined;
			} else if (rawKey !== undefined) {
				const env = await configContextEnv([rawKey], input.ctx);
				const key = resolveConfigValueOrThrow(
					rawKey,
					`API key for provider "${providerId}"`,
					env,
				);
				result = inherited
					? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
					: { auth: { apiKey: key }, source: "configured API key" };
			} else {
				result = await inherited?.resolve(input);
			}
			if (!result) return undefined;
			const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
			const headerEnv = await configContextEnv(
				Object.values(rawHeaders ?? {}),
				input.ctx,
				explicitEnv,
			);
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			return { ...result, auth: withConfiguredAuth(result.auth, headers, authHeader) };
		},
	};
}

function rawModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	const chatDefinition = isModelType(model, "chat")
		? config?.models?.find((entry) => entry.id === model.id)
		: undefined;
	const extensionModel = extension?.models?.find(
		(entry) => (entry.type ?? "chat") === (model.type ?? "chat") && entry.id === model.id,
	);
	const headers = {
		...(isModelType(model, "chat") ? config?.modelOverrides?.[model.id]?.headers : undefined),
		...chatDefinition?.headers,
		...extensionModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function validateExtensionProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput,
): void {
	if (extension.streamSimple && !extension.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyExtension(
		providerId,
		applyModelsJson(providerId, getAllProviderModels(base), modelsConfig),
		extension,
	);
}

export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	extension: ProviderConfigInput | undefined,
	onWarning?: (warning: string) => void,
): Provider {
	const config = modelConfig.getProvider(providerId);
	let refreshedExtensionModels: ProviderConfigInput["models"];

	// Endpoint models.
	let discoveredEndpointModels: AnyModel[] | undefined;

	// Drop stale
	let liveEndpointModelIds: Set<string> | undefined;
	const currentExtension = (): ProviderConfigInput | undefined =>
		refreshedExtensionModels ? { ...extension, models: refreshedExtensionModels } : extension;

	// De-dupe
	const emittedWarnings = new Set<string>();
	const emitWarning = (warning: string): void => {
		if (emittedWarnings.has(warning)) return;
		emittedWarnings.add(warning);
		onWarning?.(warning);
	};

	const configuredModelIds = new Set((config?.models ?? []).map((model) => model.id));
	const getAllModels = (): AnyModel[] => {
		const curated = applyModelsJson(providerId, getAllProviderModels(base), config, emitWarning);
		const visible = liveEndpointModelIds
			? curated.filter(
					(model) => !configuredModelIds.has(model.id) || liveEndpointModelIds!.has(model.id),
				)
			: curated;
		const composed = applyExtension(providerId, visible, currentExtension());
		const models = discoveredEndpointModels
			? [...composed, ...discoveredEndpointModels]
			: composed;
		return models.map((model) => {
			const override = config?.modelOverrides?.[model.id];
			return override && isModelType(model, "chat")
				? applyModelOverride(model, override)
				: model;
		});
	};

	getAllModels();
	const apiKey = composeApiKeyAuth(providerId, base, config, extension);
	if (!apiKey) {
		throw new Error(`Provider ${providerId}: no authentication method configured.`);
	}

	const supportsBaseApi = (model: Model<Api>) =>
		base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			const simpleOptions = options as SimpleStreamOptions;

			if (extension?.streamSimple && model.api === extension.api) {
				return extension.streamSimple(model, context, simpleOptions);
			}

			if (base && supportsBaseApi(model)) {
				if (simple) return base.streamSimple(model, context, simpleOptions);

				return base.stream(model, context, options);
			}

			const api = getApiProvider(model.api);
			if (!api) {
				throw new Error(`No API provider registered for api: ${model.api}`);
			}

			if (simple) return api.streamSimple(model, context, simpleOptions);

			return api.stream(model, context, options);
		});

	const provider: Provider = {
		id: providerId,
		name: extension?.name ?? config?.name ?? base?.name ?? providerId,
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { apiKey },
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels:
			base?.refreshModels || extension?.refreshModels
				? async (context) => {
						await base?.refreshModels?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						if (context.signal.aborted) return;
						await context.publish({
							update: () => {
								if (refreshed) {
									applyExtension(
										providerId,
										applyModelsJson(
											providerId,
											getAllProviderModels(base),
											config,
											emitWarning,
										),
										{
											...extension,
											models: refreshed,
										},
									);
									refreshedExtensionModels = refreshed;
								}
							},
						});
					}
				: (extension?.baseUrl ?? config?.baseUrl) !== undefined
					? async (context) => {
							// Network refresh.
							if (!context.allowNetwork || context.signal.aborted) return;
							const key =
								context.credential?.type === "api_key"
									? (context.credential.key ?? "")
									: "";
							const endpoint = (extension?.baseUrl ?? config?.baseUrl ?? "").trim();
							if (!key || !endpoint) return;
							const live = await fetchEndpointModels(endpoint, key, {
								signal: context.signal,
							});
							if (context.signal.aborted) return;
							const builtinModels = getAllProviderModels(base).filter(
								(model): model is Model<Api> => isModelType(model, "chat"),
							);
							const resolved = resolveModels(live, builtinModels);
							if (context.signal.aborted) return;
							const definitions: ProviderConfigInput["models"] = resolved.map((model) => ({
								id: model.id,
								name: model.name,
								input: model.input,
								cost: model.cost ?? NO_PRICE,
								reasoning: model.reasoning,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							}));
							if (context.signal.aborted) return;
							await context.publish({
								update: () => {
									if (!extension) {
										// Config models.
										const curated = applyModelsJson(
											providerId,
											getAllProviderModels(base),
											config,
											onWarning,
										);
										const known = new Set(curated.map((model) => model.id));
										liveEndpointModelIds = new Set(
											definitions.map((definition) => definition.id),
										);
										discoveredEndpointModels = definitions
											.filter((definition) => !known.has(definition.id))
											.map((definition) =>
												extensionModelFromDefinition(
													providerId,
													curated,
													{ api: config?.api, baseUrl: endpoint },
													definition,
												),
											);
										return;
									}
									applyExtension(
										providerId,
										applyModelsJson(
											providerId,
											getAllProviderModels(base),
											config,
											onWarning,
										),
										{
											...extension,
											api: extension?.api ?? config?.api,
											baseUrl: endpoint,
											models: definitions,
										},
									);
									refreshedExtensionModels = definitions;
								},
							});
						}
					: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		filterAllModels: base?.filterAllModels
			? (models, credential: Credential | undefined) => base.filterAllModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	const fetchDeferred = base?.fetchDeferred;
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	const cancelDeferred = base?.cancelDeferred;
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}
	const extensionImages = extension?.images;
	const generateImages = base?.generateImages;
	if (generateImages || Object.keys(extensionImages ?? {}).length > 0) {
		provider.generateImages = (model, context, options) => {
			const implementation = extensionImages?.[model.api];
			if (implementation) return implementation.generateImages(model, context, options);
			if (generateImages) return generateImages(model, context, options);
			return Promise.resolve(
				imageErrorResult(
					model,
					new Error(`Provider ${providerId} has no image implementation for "${model.api}"`),
				),
			);
		};
	}
	const extensionClassifiers = extension?.classifiers;
	const classify = base?.classify;
	if (classify || Object.keys(extensionClassifiers ?? {}).length > 0) {
		provider.classify = (model, context, options) => {
			const implementation = extensionClassifiers?.[model.api];
			if (implementation) return implementation.classify(model, context, options);
			if (classify) return classify(model, context, options);
			return Promise.resolve(
				classifierErrorResult(
					model,
					new Error(
						`Provider ${providerId} has no classifier implementation for "${model.api}"`,
					),
				),
			);
		};
	}

	return provider;
}

export function resolveConfiguredModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, extension),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

export function resolveCompatibilityRequestConfig(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const configured = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) return undefined;
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return {
		configured: true,
		source: extension?.apiKey !== undefined ? "fallback" : "models_json_key",
	};
}
