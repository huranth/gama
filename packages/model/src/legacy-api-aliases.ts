import { anthropicMessagesApi } from "./wire/anthropic-messages.lazy.ts";
import type { AnthropicOptions } from "./wire/anthropic-messages.ts";
import { azureOpenAIResponsesApi } from "./wire/azure-openai-responses.lazy.ts";
import type { AzureOpenAIResponsesOptions } from "./wire/azure-openai-responses.ts";
import { googleGenerativeAIApi } from "./wire/google-generative-ai.lazy.ts";
import type { GoogleOptions } from "./wire/google-generative-ai.ts";
import { googleVertexApi } from "./wire/google-vertex.lazy.ts";
import type { GoogleVertexOptions } from "./wire/google-vertex.ts";
import { mistralConversationsApi } from "./wire/mistral-conversations.lazy.ts";
import type { MistralOptions } from "./wire/mistral-conversations.ts";
import { openAICodexResponsesApi } from "./wire/openai-codex-responses.lazy.ts";
import type { OpenAICodexResponsesOptions } from "./wire/openai-codex-responses.ts";
import { openAICompletionsApi } from "./wire/openai-completions.lazy.ts";
import type { OpenAICompletionsOptions } from "./wire/openai-completions.ts";
import { openAIResponsesApi } from "./wire/openai-responses.lazy.ts";
import type { OpenAIResponsesOptions } from "./wire/openai-responses.ts";
import type { SimpleStreamOptions, StreamFunction } from "./types.ts";

const anthropicMessagesStreams = anthropicMessagesApi();

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> =
	anthropicMessagesStreams.stream;

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> =
	anthropicMessagesStreams.streamSimple;

const azureOpenAIResponsesStreams = azureOpenAIResponsesApi();

export const streamAzureOpenAIResponses: StreamFunction<
	"azure-openai-responses",
	AzureOpenAIResponsesOptions
> = azureOpenAIResponsesStreams.stream;

export const streamSimpleAzureOpenAIResponses: StreamFunction<
	"azure-openai-responses",
	SimpleStreamOptions
> = azureOpenAIResponsesStreams.streamSimple;

const googleGenerativeAIStreams = googleGenerativeAIApi();

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> =
	googleGenerativeAIStreams.stream;

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> =
	googleGenerativeAIStreams.streamSimple;

const googleVertexStreams = googleVertexApi();

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> =
	googleVertexStreams.stream;

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> =
	googleVertexStreams.streamSimple;

const mistralConversationsStreams = mistralConversationsApi();

export const streamMistral: StreamFunction<"mistral-conversations", MistralOptions> =
	mistralConversationsStreams.stream;

export const streamSimpleMistral: StreamFunction<"mistral-conversations", SimpleStreamOptions> =
	mistralConversationsStreams.streamSimple;

const openAICodexResponsesStreams = openAICodexResponsesApi();

export const streamOpenAICodexResponses: StreamFunction<
	"openai-codex-responses",
	OpenAICodexResponsesOptions
> = openAICodexResponsesStreams.stream;

export const streamSimpleOpenAICodexResponses: StreamFunction<
	"openai-codex-responses",
	SimpleStreamOptions
> = openAICodexResponsesStreams.streamSimple;

const openAICompletionsStreams = openAICompletionsApi();

export const streamOpenAICompletions: StreamFunction<
	"openai-completions",
	OpenAICompletionsOptions
> = openAICompletionsStreams.stream;

export const streamSimpleOpenAICompletions: StreamFunction<
	"openai-completions",
	SimpleStreamOptions
> = openAICompletionsStreams.streamSimple;

const openAIResponsesStreams = openAIResponsesApi();

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> =
	openAIResponsesStreams.stream;

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> =
	openAIResponsesStreams.streamSimple;
