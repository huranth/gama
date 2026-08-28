import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getGamaUserAgent } from "../utils/gama-user-agent.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import {
	getDeclaredTools,
	resolveTranscript,
	resolveTranscriptTools,
} from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface AzureOpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}

const DEFAULT_AZURE_API_VERSION = "v1";
const AZURE_TOOL_CALL_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"opencode",
	"azure-openai-responses",
]);
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function formatAzureOpenAIError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "Azure OpenAI API error");
}

function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

function createClient(
	model: Model<"azure-openai-responses">,
	apiKey: string,
	options?: AzureOpenAIResponsesOptions,
) {
	const headers = { "User-Agent": getGamaUserAgent(), ...model.headers };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		fetch: options?.fetch,
		defaultHeaders: headers,
		baseURL: baseUrl,
	});
}

function resolveDeploymentName(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseDeploymentNameMap(
		getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options?.env),
	).get(model.id);
	return mappedDeployment || model.id;
}

function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;

	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") ||
		url.hostname.endsWith(".cognitiveservices.azure.com") ||
		url.hostname.endsWith(".ai.azure.com");
	const path = url.pathname.replace(/\/+$/, "");
	const isRootPath =
		path === "" || path === "/" || path === "/openai" || path === "/openai/v1/responses";

	if (!isAzureHost || !isRootPath) return url.toString().replace(/\/+$/, "");

	url.pathname = "/openai/v1";
	url.search = "";

	return url.toString().replace(/\/+$/, "");
}

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;

	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;

		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;

		map.set(modelId.trim(), deploymentName.trim());
	}

	return map;
}

function resolveBaseUrl(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): string {
	const explicitBaseUrl = options?.azureBaseUrl?.trim();
	if (explicitBaseUrl) return explicitBaseUrl;

	const envBaseUrl = getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim();
	if (envBaseUrl) return envBaseUrl;

	const resourceName =
		options?.azureResourceName ?? getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);
	if (resourceName) return buildDefaultBaseUrl(resourceName);

	if (model.baseUrl) return model.baseUrl;

	throw new Error(
		"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or " +
			"AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
	);
}

function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion =
		options?.azureApiVersion ||
		getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) ||
		DEFAULT_AZURE_API_VERSION;

	return {
		baseUrl: normalizeAzureBaseUrl(resolveBaseUrl(model, options)),
		apiVersion,
	};
}

export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(
		context,
		model.compat?.supportsMidConvoSystemMessages,
	);

	(async () => {
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "azure-openai-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				deploymentName,
				grammarToolInputProperties,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				grammarToolInputProperties,
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Azure OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatAzureOpenAIError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AzureOpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning
		? clampThinkingLevel(model, options.reasoning)
		: undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies AzureOpenAIResponsesOptions);
};

function buildParams(
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
) {
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		supportsAdditionalTools || supportsToolSearch,
	);
	const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools,
		supportsToolSearch,
		toolOptions: {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		},
	});

	const params: ResponseCreateParamsStreaming = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		});
	}
	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	applyReasoning(params, model, options);
	Object.assign(params, model.samplingParams, options?.samplingParams);

	return params;
}

function applyReasoning(
	params: ResponseCreateParamsStreaming,
	model: Model<"azure-openai-responses">,
	options: AzureOpenAIResponsesOptions | undefined,
): void {
	if (!model.reasoning) return;

	const requested = options?.reasoningEffort;
	const summary = options?.reasoningSummary;
	if (!requested && !summary) {
		if (model.thinkingLevelMap?.off === null) return;

		const offEffort = model.thinkingLevelMap?.off ?? "none";
		params.reasoning = {
			effort: offEffort as NonNullable<typeof params.reasoning>["effort"],
		};
		return;
	}

	const effort = requested ? (model.thinkingLevelMap?.[requested] ?? requested) : "medium";
	params.reasoning = {
		effort: effort as NonNullable<typeof params.reasoning>["effort"],
		summary: summary || "auto",
	};
	params.include = ["reasoning.encrypted_content"];
}
