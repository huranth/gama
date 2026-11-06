import type { ThinkingLevel } from "@huranth/gama-agent-core";
import { type Api, type AuthOperationOptions, type Model, modelsAreEqual } from "@huranth/gama-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { parseThinkingLevel } from "../start/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelHub } from "./model-run.ts";

export interface ScopedModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

export interface ModelScopeDiagnostic {
	type: "warning";
	code: "no-match" | "invalid-thinking-level";
	message: string;
	pattern: string;
}

export interface ResolveModelScopeResult {
	scopedModels: ScopedModel[];
	diagnostics: ModelScopeDiagnostic[];
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	error: string | undefined;
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

function isAlias(id: string): boolean {
	if (id.endsWith("-latest")) return true;

	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

function filterConfiguredAuth(
	models: readonly Model<Api>[],
	modelRuntime: ModelHub,
): Model<Api>[] {
	return models.filter((model) => modelRuntime.hasConfiguredAuth(model.provider));
}

function findModelsByIdReference(
	models: readonly Model<Api>[],
	reference: string,
): Model<Api>[] {
	const lower = reference.toLowerCase();

	return models.filter(
		(model) =>
			model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower,
	);
}

function pushScopedModel(
	scopedModels: ScopedModel[],
	model: Model<Api>,
	thinkingLevel: ThinkingLevel | undefined,
): void {
	if (scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

	scopedModels.push({ model, thinkingLevel });
}

function noMatchDiagnostic(pattern: string): ModelScopeDiagnostic {
	return {
		type: "warning",
		code: "no-match",
		message: `No models match pattern "${pattern}"`,
		pattern,
	};
}

function buildFallbackModel(
	provider: string,
	modelId: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const providerModels = availableModels.filter((model) => model.provider === provider);
	if (providerModels.length === 0) return undefined;

	const baseModel = providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");

	if (slashIndex === -1) {
		const idMatches = availableModels.filter(
			(model) => model.id.toLowerCase() === normalizedReference,
		);

		return idMatches.length === 1 ? idMatches[0] : undefined;
	}

	const provider = trimmedReference.substring(0, slashIndex).trim();
	const modelId = trimmedReference.substring(slashIndex + 1).trim();
	if (!provider || !modelId) return undefined;

	const providerMatches = availableModels.filter(
		(model) =>
			model.provider.toLowerCase() === provider.toLowerCase() &&
			model.id.toLowerCase() === modelId.toLowerCase(),
	);

	if (providerMatches.length === 1) {
		return providerMatches[0];
	}

	return undefined;
}

function tryMatchModel(
	modelPattern: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	const lowerPattern = modelPattern.toLowerCase();
	const matches = availableModels.filter(
		(model) =>
			model.id.toLowerCase().includes(lowerPattern) ||
			model.name?.toLowerCase().includes(lowerPattern),
	);

	if (matches.length === 0) {
		return undefined;
	}

	const aliases = matches.filter((model) => isAlias(model.id));
	const datedVersions = matches.filter((model) => !isAlias(model.id));

	if (aliases.length > 0) {
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	}

	datedVersions.sort((a, b) => b.id.localeCompare(a.id));
	return datedVersions[0];
}

export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelHub,
	options?: AuthOperationOptions,
): Promise<ResolveModelScopeResult> {
	return resolveModelScopeFromModels(
		patterns,
		await modelRuntime.getAvailable(undefined, options),
	);
}

export async function resolveModelScope(
	patterns: string[],
	modelRuntime: ModelHub,
	options?: AuthOperationOptions,
): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(
		patterns,
		modelRuntime,
		options,
	);

	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}

	return scopedModels;
}

export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	const tier = parseThinkingLevel(suffix);
	if (tier) {
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : tier,
				warning: result.warning,
			};
		}
		return result;
	}

	const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
	if (!allowFallback) {
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const result = parseModelPattern(prefix, availableModels, options);
	if (result.model) {
		return {
			model: result.model,
			thinkingLevel: undefined,
			warning:
				`Invalid thinking level "${suffix}" in pattern "${pattern}". ` +
				"Using default instead.",
		};
	}
	return result;
}

export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	const availableModels = [...models];
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];

	for (const pattern of patterns) {
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			const colonIndex = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIndex !== -1) {
				const suffix = pattern.substring(colonIndex + 1);
				const tier = parseThinkingLevel(suffix);
				if (tier) {
					thinkingLevel = tier;
					globPattern = pattern.substring(0, colonIndex);
				}
			}

			const exactMatch = findExactModelReferenceMatch(globPattern, availableModels);
			if (exactMatch) {
				pushScopedModel(scopedModels, exactMatch, thinkingLevel);
				continue;
			}

			const matchingModels = availableModels.filter((model) => {
				const fullId = `${model.provider}/${model.id}`;
				return (
					minimatch(fullId, globPattern, { nocase: true }) ||
					minimatch(model.id, globPattern, { nocase: true })
				);
			});

			if (matchingModels.length === 0) {
				diagnostics.push(noMatchDiagnostic(pattern));
				continue;
			}

			for (const model of matchingModels) {
				pushScopedModel(scopedModels, model, thinkingLevel);
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			diagnostics.push({
				type: "warning",
				code: "invalid-thinking-level",
				message: warning,
				pattern,
			});
		}

		if (!model) {
			diagnostics.push(noMatchDiagnostic(pattern));
			continue;
		}

		pushScopedModel(scopedModels, model, thinkingLevel);
	}

	return { scopedModels, diagnostics };
}

export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	modelRuntime: ModelHub;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelThinkingLevels,
		modelRuntime,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRuntime,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return {
				model: resolved.model,
				thinkingLevel: DEFAULT_THINKING_LEVEL,
				fallbackMessage: undefined,
			};
		}
	}

	if (scopedModels.length > 0 && !isContinuing) {
		const scopedModel = scopedModels[0];
		const perModel =
			modelThinkingLevels?.[`${scopedModel.model.provider}/${scopedModel.model.id}`];
		return {
			model: scopedModel.model,
			thinkingLevel:
				scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			if (perModel) {
				thinkingLevel = perModel;
			} else if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
		const reason = !found ? "not in the local model catalog" : "no auth configured";
		const savedFallbackMessage =
			`Could not restore model ${defaultProvider}/${defaultModelId} ` + `(${reason}).`;
		const availableModels = [...modelRuntime.getAvailableSnapshot()];

		if (availableModels.length > 0) {
			const fallbackModel = availableModels[0];
			return {
				model: fallbackModel,
				thinkingLevel: DEFAULT_THINKING_LEVEL,
				fallbackMessage:
					`${savedFallbackMessage} Using ` + `${fallbackModel.provider}/${fallbackModel.id}.`,
			};
		}

		return {
			model: undefined,
			thinkingLevel: DEFAULT_THINKING_LEVEL,
			fallbackMessage: savedFallbackMessage,
		};
	}

	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		return {
			model: availableModels[0],
			thinkingLevel: DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	cliThinking?: ThinkingLevel;
	modelRuntime: ModelHub;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, cliThinking, modelRuntime } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	const availableModels = [...modelRuntime.getModels()];
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models",
		};
	}

	const providerMap = new Map<string, string>();
	for (const model of availableModels) {
		providerMap.set(model.provider.toLowerCase(), model.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error:
				`Unknown provider "${cliProvider}". ` +
				"Use --list-models to see available providers/models.",
		};
	}

	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	if (!provider) {
		const exactMatches = findModelsByIdReference(availableModels, cliModel);
		if (exactMatches.length === 1) {
			return {
				model: exactMatches[0],
				warning: undefined,
				thinkingLevel: undefined,
				error: undefined,
			};
		}
		if (exactMatches.length > 1) {
			const authenticatedExactMatches = filterConfiguredAuth(exactMatches, modelRuntime);
			if (authenticatedExactMatches.length === 1) {
				return {
					model: authenticatedExactMatches[0],
					warning: undefined,
					thinkingLevel: undefined,
					error: undefined,
				};
			}

			const matches = exactMatches
				.map((model) => `${model.provider}/${model.id}`)
				.sort((a, b) => a.localeCompare(b))
				.join(", ");
			const authHint =
				authenticatedExactMatches.length === 0
					? "No matching provider is authenticated."
					: "More than one matching provider is authenticated.";
			return {
				model: undefined,
				warning: undefined,
				thinkingLevel: undefined,
				error:
					`Model "${cliModel}" is ambiguous across providers: ${matches}. ` +
					`${authHint} Use --provider or provider/model.`,
			};
		}
	}

	if (cliProvider && provider) {
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider
		? availableModels.filter((model) => model.provider === provider)
		: availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		if (inferredProvider) {
			const rawExactMatches = availableModels.filter(
				(candidate) =>
					candidate.id.toLowerCase() === cliModel.toLowerCase() &&
					!modelsAreEqual(candidate, model),
			);
			if (rawExactMatches.length > 0 && !modelRuntime.hasConfiguredAuth(model.provider)) {
				const authenticatedRawMatches = filterConfiguredAuth(rawExactMatches, modelRuntime);
				if (authenticatedRawMatches.length === 1) {
					return {
						model: authenticatedRawMatches[0],
						thinkingLevel: undefined,
						warning: undefined,
						error: undefined,
					};
				}
			}
		}
		return { model, thinkingLevel, warning, error: undefined };
	}

	if (inferredProvider) {
		const exact = findModelsByIdReference(availableModels, cliModel)[0];
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		let fallbackPattern = pattern;
		let fallbackThinking: ThinkingLevel | undefined;
		if (!cliThinking) {
			const lastColon = pattern.lastIndexOf(":");
			if (lastColon !== -1) {
				const suffix = pattern.substring(lastColon + 1);
				const tier = parseThinkingLevel(suffix);
				if (tier) {
					fallbackPattern = pattern.substring(0, lastColon);
					fallbackThinking = tier;
				}
			}
		}

		const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
		if (fallbackModel) {
			const requestedThinking = cliThinking ?? fallbackThinking;
			const model =
				requestedThinking && requestedThinking !== "off"
					? { ...fallbackModel, reasoning: true }
					: fallbackModel;
			const missing = `Model "${fallbackPattern}" not found for provider "${provider}".`;
			const customNote = "Using custom model id.";
			const fallbackWarning = warning
				? `${warning} ${missing} ${customNote}`
				: `${missing} ${customNote}`;
			return {
				model,
				thinkingLevel: fallbackThinking,
				warning: fallbackWarning,
				error: undefined,
			};
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}
