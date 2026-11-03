import {
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	ResourceScope,
} from "@google/genai";
import { clampThinkingLevel } from "../registry.ts";
import type {
	AssistantMessage,
	GoogleApiThinkingLevel,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { ReplyStream } from "../utils/event-stream.ts";
import { getGamaUserAgent } from "../utils/gama-user-agent.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { appendSystemUpdatesAsUser } from "../utils/transcript.ts";
import {
	resolveGoogleBudget,
	resolveGoogleThinkingLevel,
	retryGoogleRequest,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import {
	buildGoogleParams,
	consumeGoogleStream,
	resolveTimeoutMs,
	stripBlockIndexes,
} from "./google-stream.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
	project?: string;
	location?: string;
}

const API_VERSION = "v1";

const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
	env?: ProviderEnv,
	timeoutMs?: number,
): GoogleGenAI {
	const googleAuthOptions = buildGoogleAuthOptions(env);

	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		httpOptions: buildHttpOptions(model, optionsHeaders, timeoutMs),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	timeoutMs?: number,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders, timeoutMs),
	});
}

function buildHttpOptions(
	model: Model<"google-vertex">,
	optionsHeaders?: ProviderHeaders,
	timeoutMs?: number,
): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	const timeout = resolveTimeoutMs(timeoutMs);
	if (timeout !== undefined) httpOptions.timeout = timeout;
	// Single attempt
	httpOptions.retryOptions = { attempts: 1 };
	const headers = providerHeadersToRecord({
		"User-Agent": getGamaUserAgent(),
		...model.headers,
		...optionsHeaders,
	});

	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;

		if (baseUrlIncludesApiVersion(baseUrl)) httpOptions.apiVersion = "";
	}

	if (headers) httpOptions.headers = headers;

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed) return undefined;
	if (trimmed.includes("{location}")) return undefined;

	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		const parts = url.pathname.split("/");

		return parts.some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	if (!keyFilename) return undefined;

	return { keyFilename };
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey) return undefined;
	if (apiKey === GCP_VERTEX_CREDENTIALS_MARKER) return undefined;
	if (isPlaceholderApiKey(apiKey)) return undefined;

	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);

	if (!project) {
		throw new Error("Missing project ID");
	}

	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	if (!location) {
		throw new Error("Missing location");
	}

	return location;
}

export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: GoogleVertexOptions,
): ReplyStream => {
	const stream = new ReplyStream();
	const transcript = appendSystemUpdatesAsUser(context);

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex",
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
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error("Custom fetch unsupported");
			}

			const apiKey = resolveApiKey(options);
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers, options?.timeoutMs)
				: createClient(
						model,
						resolveProject(options),
						resolveLocation(options),
						options?.headers,
						options?.env,
						options?.timeoutMs,
					);

			let params = buildGoogleParams(model, transcript, options);

			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) params = nextParams as GenerateContentParameters;

			const googleStream = await retryGoogleRequest(
				() => client.models.generateContentStream(params),
				options,
			);

			await consumeGoogleStream({
				googleStream,
				stream,
				output,
				model,
				options,
				pendingMessage: "No finish reason",
			});
		} catch (error) {
			stripBlockIndexes(output);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));

			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): ReplyStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies GoogleVertexOptions;

	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } });
	}

	const clamped = clampThinkingLevel(model, options.reasoning);
	if (clamped === "off") {
		return stream(model, context, { ...base, thinking: { enabled: false } });
	}

	const level = resolveGoogleThinkingLevel(model, clamped);
	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, level: toGoogleThinkingLevel(level) },
		});
	}

	const budgetTokens = resolveGoogleBudget(model.id, level, options.thinkingBudgets);

	return stream(model, context, { ...base, thinking: { enabled: true, budgetTokens } });
};
