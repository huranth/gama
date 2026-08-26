import { calculateCost } from "../models.ts";
import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
	ProviderHeaders,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";

export interface SystemOneWireRequest {
	state: ClassifierContext["state"];
	questions: Record<string, unknown>;
}

export interface SystemOneTransport {
	api: ClassifierApi;
	label: string;
	url(model: ClassifierModel<ClassifierApi>): URL;
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	output(body: unknown): Record<string, unknown>;
}

type SystemOneError = Error & {
	status?: number;
	headers?: Headers;
	body?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpError(label: string, response: Response, body: string): SystemOneError {
	const error = new Error(`${label} returned ${response.status}`) as SystemOneError;

	error.status = response.status;
	error.headers = response.headers;
	error.body = body;

	return error;
}

function timeoutError(timeoutMs: number): SystemOneError {
	const error = new Error(`Request timed out after ${timeoutMs}ms`) as SystemOneError;

	error.name = "TimeoutError";
	error.status = undefined;
	error.headers = undefined;
	error.body = "";

	return error;
}

function combineSignals(
	signal: AbortSignal | undefined,
	timeoutSignal: AbortSignal | undefined,
): AbortSignal | undefined {
	if (signal && timeoutSignal) return AbortSignal.any([signal, timeoutSignal]);

	return signal ?? timeoutSignal;
}

function wireQuestion(question: ClassifierQuestion): unknown {
	if (question.type !== "bool") return question;

	return { ...question, type: "noul" };
}

function wireRequest(context: ClassifierContext): SystemOneWireRequest {
	const questions = Object.entries(context.questions).map(([id, question]) => [
		id,
		wireQuestion(question),
	]);

	return {
		state: context.state,
		questions: Object.fromEntries(questions),
	};
}

function requestHeaders(
	model: ClassifierModel<ClassifierApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): Record<string, string> {
	const headers = providerHeadersToRecord(
		{ authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		model.headers,
		optionsHeaders,
	);

	return headers ?? {};
}

function requiredNumber(label: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}

	return value;
}

function tokenCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;

	return value;
}

function probabilities(label: string, value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);

	const entries = Object.entries(value).map(([key, probability]) => [
		key,
		requiredNumber(label, probability, `probability for ${id}.${key}`),
	]);

	return Object.fromEntries(entries);
}

function parseUsage(value: unknown, model: ClassifierModel<ClassifierApi>): Usage | undefined {
	if (!isRecord(value)) return undefined;

	const hasTokens = value.input_tokens !== undefined || value.output_tokens !== undefined;
	if (!hasTokens) return undefined;

	const input = tokenCount(value.input_tokens);
	const output = tokenCount(value.output_tokens);
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	calculateCost(model, usage);

	return usage;
}

function parseAnswer(
	label: string,
	id: string,
	question: ClassifierQuestion,
	answer: unknown,
): ClassifierAnswer {
	if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);

	if (question.type === "choice") {
		if (answer.type !== "choice" || typeof answer.choice !== "string") {
			throw new Error(`${label} did not return a choice answer for ${id}`);
		}

		return {
			type: "choice",
			choice: answer.choice,
			probabilities: probabilities(label, answer.probabilities, id),
			confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
		};
	}

	if (question.type === "score") {
		if (answer.type !== "score") {
			throw new Error(`${label} did not return a score answer for ${id}`);
		}

		return {
			type: "score",
			score: requiredNumber(label, answer.score, `score for ${id}`),
			confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
		};
	}

	if (answer.type !== "noul") {
		throw new Error(`${label} did not return a bool answer for ${id}`);
	}

	return {
		type: "bool",
		probability: requiredNumber(label, answer.noul, `probability for ${id}`),
	};
}

function parseAnswers(
	label: string,
	value: unknown,
	context: ClassifierContext,
): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);

	const answers: Array<[string, ClassifierAnswer]> = [];

	for (const [id, question] of Object.entries(context.questions)) {
		answers.push([id, parseAnswer(label, id, question, value[id])]);
	}

	return Object.fromEntries(answers);
}

async function sendRequest(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	payload: unknown,
	apiKey: string,
	options: ClassifierOptions | undefined,
): Promise<{ response: Response; body: unknown }> {
	const timeoutMs = options?.timeoutMs;
	const timeoutSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
	const signal = combineSignals(options?.signal, timeoutSignal);
	const requestFetch = options?.fetch ?? globalThis.fetch;

	try {
		const response = await requestFetch(transport.url(model), {
			method: "POST",
			headers: requestHeaders(model, apiKey, options?.headers),
			body: JSON.stringify(payload),
			signal,
		});

		if (!response.ok) throw httpError(transport.label, response, await response.text());

		const body = (await response.json()) as unknown;

		return { response, body };
	} catch (error) {
		const timedOut = timeoutSignal?.aborted && !options?.signal?.aborted;
		if (timedOut && timeoutMs !== undefined) throw timeoutError(timeoutMs);

		throw error;
	}
}

async function requestClassifier(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	apiKey: string,
	options: ClassifierOptions | undefined,
): Promise<Record<string, unknown>> {
	let payload = transport.payload(model, wireRequest(context));
	const nextPayload = await options?.onPayload?.(payload, model);
	if (nextPayload !== undefined) payload = nextPayload;

	const { response, body } = await retryProviderRequest(
		() => sendRequest(transport, model, payload, apiKey, options),
		{
			maxRetries: options?.maxRetries ?? 2,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);

	await options?.onResponse?.(
		{ status: response.status, headers: headersToRecord(response.headers) },
		model,
	);

	return transport.output(body);
}

export async function classifySystemOne(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);

		const apiKey = options?.apiKey;
		if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

		const result = await requestClassifier(transport, model, context, apiKey, options);
		const usage = parseUsage(result.usage, model);
		if (usage) output.usage = usage;

		output.answers = parseAnswers(transport.label, result.answers, context);

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(
			normalizeProviderError(error),
			`${transport.label} error`,
		);

		return output;
	}
}
