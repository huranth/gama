import type { StreamFn, ThinkingLevel } from "@huranth/gama-agent-core";
import { contentText, normalizeContext, type RetryPolicy, type Usage } from "@huranth/gama-ai";
import type { Api, Model, SimpleStreamOptions } from "@huranth/gama-ai/compat";
import { completeSummarization, getSummarizationFailure } from "./comp/compaction.ts";

const PROMPT_SUMMARY_SYSTEM_PROMPT =
	"You summarize the request a user sent to a coding agent. Reply with one short sentence " +
	"(at most 25 words) describing what the user wants. Do not answer the request or continue " +
	"the conversation; output only the summary sentence.";

export interface SummarizePromptOptions {
	model: Model<Api>;
	prompt: string;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	thinkingLevel: ThinkingLevel;
	signal?: AbortSignal;
	streamFn: StreamFn;
	retry: RetryPolicy;
	sessionId: string;
}

export interface PromptSummaryResult {
	text: string;
	usage: Usage;
}

function buildRequestOptions(options: SummarizePromptOptions): SimpleStreamOptions {
	const { model } = options;
	const maxTokens = Math.min(
		256,
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	const level = options.thinkingLevel;
	const reasoning = model.reasoning && level !== "off" ? level : undefined;

	return {
		maxTokens,
		signal: options.signal,
		apiKey: options.apiKey,
		headers: options.headers,
		env: options.env,
		sessionId: options.sessionId,
		...(reasoning ? { reasoning } : {}),
	};
}

export async function summarizePromptText(
	options: SummarizePromptOptions,
): Promise<PromptSummaryResult> {
	const { model } = options;
	const requestOptions = buildRequestOptions(options);
	const response = await completeSummarization(
		model,
		normalizeContext({
			systemPrompt: PROMPT_SUMMARY_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: options.prompt }],
					timestamp: Date.now(),
				},
			],
		}),
		requestOptions,
		options.streamFn,
		options.retry,
	);

	if (response.stopReason === "aborted") throw new Error("Prompt summary was cancelled");

	const failure = getSummarizationFailure(response, "Prompt summary");
	if (failure) throw new Error(failure);

	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Prompt summary attempted to call a tool");
	}

	const text = contentText(response.content).trim();
	if (!text) throw new Error("Prompt summary was empty");
	return { text, usage: response.usage };
}
