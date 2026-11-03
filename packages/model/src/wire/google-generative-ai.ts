import { type GenerateContentParameters, GoogleGenAI } from "@google/genai";
import { clampThinkingLevel } from "../registry.ts";
import type {
	AssistantMessage,
	GoogleApiThinkingLevel,
	Model,
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

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
}

interface HttpOptions {
	baseUrl?: string;
	apiVersion?: string;
	headers?: Record<string, string>;
	timeout?: number;
	retryOptions?: { attempts?: number };
}

const GOOGLE_FETCH_MESSAGE = "Custom fetch unsupported";

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
	timeoutMs?: number,
): GoogleGenAI {
	const httpOptions: HttpOptions = model.baseUrl ? { baseUrl: model.baseUrl, apiVersion: "" } : {};
	const timeout = resolveTimeoutMs(timeoutMs);
	if (timeout !== undefined) httpOptions.timeout = timeout;
	// Single attempt
	httpOptions.retryOptions = { attempts: 1 };
	const headers = providerHeadersToRecord({
		"User-Agent": getGamaUserAgent(),
		...model.headers,
		...optionsHeaders,
	});

	if (headers) httpOptions.headers = headers;

	const hasOptions = Object.keys(httpOptions).length > 0;

	return new GoogleGenAI({ apiKey, httpOptions: hasOptions ? httpOptions : undefined });
}

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: GoogleOptions,
): ReplyStream => {
	const stream = new ReplyStream();
	const transcript = appendSystemUpdatesAsUser(context);

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai",
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
			const customFetch = options?.fetch;
			if (customFetch && customFetch !== globalThis.fetch) {
				throw new Error(GOOGLE_FETCH_MESSAGE);
			}

			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error(`No API key: ${model.provider}`);

			const client = createClient(model, apiKey, options?.headers, options?.timeoutMs);
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

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): ReplyStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key: ${model.provider}`);

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleOptions;

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
