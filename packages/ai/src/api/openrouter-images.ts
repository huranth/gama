import OpenAI from "openai";
import type {
	ChatCompletion,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";
import type {
	AssistantImages,
	ImageApi,
	ImageContent,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
	ProviderHeaders,
	TextContent,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/;

interface OpenRouterGeneratedImage {
	image_url?: string | { url?: string };
}

type OpenRouterImageGenerationMessage = ChatCompletion["choices"][number]["message"] & {
	images?: OpenRouterGeneratedImage[];
};

type OpenRouterImageGenerationChoice = ChatCompletion["choices"][number] & {
	message: OpenRouterImageGenerationMessage;
};

type OpenRouterImageGenerationResponse = ChatCompletion & {
	choices: OpenRouterImageGenerationChoice[];
};

type OpenRouterImagesCreateParams = Omit<ChatCompletionCreateParamsNonStreaming, "modalities"> & {
	modalities: Array<"image" | "text">;
};

function createClient(
	model: ImageModel<ImageApi>,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: providerHeadersToRecord({ ...model.headers, ...optionsHeaders }),
	});
}

function toContentPart(item: TextContent | ImageContent): ChatCompletionContentPart {
	if (item.type === "text") {
		return {
			type: "text",
			text: sanitizeSurrogates(item.text),
		} satisfies ChatCompletionContentPartText;
	}

	return {
		type: "image_url",
		image_url: {
			url: `data:${item.mimeType};base64,${item.data}`,
		},
	} satisfies ChatCompletionContentPartImage;
}

function buildParams(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
): OpenRouterImagesCreateParams {
	const content = context.input.map(toContentPart);

	return {
		model: model.id,
		messages: [
			{
				role: "user" as const,
				content,
			},
		],
		stream: false,
		modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
	};
}

function parseGeneratedImages(images: OpenRouterGeneratedImage[] | undefined): ImageContent[] {
	const result: ImageContent[] = [];

	for (const image of images ?? []) {
		const url = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
		if (!url?.startsWith("data:")) continue;

		const matches = url.match(DATA_URL_PATTERN);
		if (!matches) continue;

		result.push({
			type: "image",
			mimeType: matches[1],
			data: matches[2],
		});
	}

	return result;
}

function parseUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	},
	model: ImageModel<ImageApi>,
): Usage {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const cacheReadTokens =
		cacheWriteTokens > 0
			? Math.max(0, reportedCachedTokens - cacheWriteTokens)
			: reportedCachedTokens;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const output = rawUsage.completion_tokens || 0;
	const usage: Usage = {
		input,
		output,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + output + cacheReadTokens + cacheWriteTokens,
		cost: {
			input: (model.cost.input / 1000000) * input,
			output: (model.cost.output / 1000000) * output,
			cacheRead: (model.cost.cacheRead / 1000000) * cacheReadTokens,
			cacheWrite: (model.cost.cacheWrite / 1000000) * cacheWriteTokens,
			total: 0,
		},
	};

	usage.cost.total =
		usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;

	return usage;
}

export const generateImages: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

		const client = createClient(model, apiKey, options?.headers, options?.fetch);
		let params = buildParams(model, context);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) params = nextParams as typeof params;

		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data: response, response: rawResponse } = await retryProviderRequest(
			() =>
				client.chat.completions
					.create(params as unknown as ChatCompletionCreateParamsNonStreaming, requestOptions)
					.withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);
		await options?.onResponse?.(
			{ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) },
			model,
		);

		const imageResponse = response as OpenRouterImageGenerationResponse;
		output.responseId = imageResponse.id;
		if (imageResponse.usage) output.usage = parseUsage(imageResponse.usage, model);

		const choice = imageResponse.choices[0];
		if (choice) {
			const content = choice.message.content;
			if (typeof content === "string" && content.length > 0) {
				output.output.push({ type: "text", text: content });
			}

			output.output.push(...parseGeneratedImages(choice.message.images));
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));

		return output;
	}
};
