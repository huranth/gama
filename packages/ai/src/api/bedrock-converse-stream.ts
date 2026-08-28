import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	CachePointType,
	CacheTTL,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamCommandInput,
	ImageFormat,
	type SystemContentBlock,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { DocumentType, HttpResponse } from "@smithy/types";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	JsonObject,
	Model,
	ProviderEnv,
	ProviderResponse,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	collapseSystemMessages,
	getCurrentTools,
	getInitialSystemMessage,
	type TranscriptContext,
	withoutInitialSystemMessage,
} from "../utils/transcript.ts";
import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export type BedrockThinkingDisplay = "summarized" | "omitted";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	reasoning?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
	interleavedThinking?: boolean;
	thinkingDisplay?: BedrockThinkingDisplay;
	requestMetadata?: Record<string, string>;
	bearerToken?: string;
}

type Block = (TextContent | ThinkingContent | ToolCall) & {
	index?: number;
	partialJson?: string;
	redactedChunks?: Uint8Array[];
};

type SdkErrorMetadata = { $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };

const EMPTY_TEXT_PLACEHOLDER = "<empty>";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";
const BEDROCK_DATA_RETENTION_DOCS_URL =
	"https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";
const MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS = 200;
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};
const ADAPTIVE_THINKING_MATCHES = [
	"opus-4-6",
	"opus-4-7",
	"opus-4-8",
	"opus-5",
	"sonnet-4-6",
	"sonnet-5",
	"fable-5",
];
const ADVANCED_THINKING_MATCHES = ["opus-4-7", "opus-4-8", "opus-5", "sonnet-5", "fable-5"];
const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 16384,
};

function finalizeStreamingBlock(block: Block): void {
	delete block.index;
	delete block.partialJson;
	flushRedactedContent(block);
}

function getModelMatchCandidates(modelId: string, modelName: string | undefined): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function createNonBlankTextBlock(text: string): { text: string } | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

function createRequiredTextBlock(text: string): { text: string } {
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

function toProviderResponse(response: unknown): ProviderResponse | undefined {
	if (!isSmithyHttpResponse(response)) return undefined;
	return { status: response.statusCode, headers: { ...response.headers } };
}

function mapStopReason(reason: string | undefined): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return { stopReason: "stop" };
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return { stopReason: "length" };
		case BedrockStopReason.TOOL_USE:
			return { stopReason: "toolUse" };
		default:
			return reason
				? { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` }
				: { stopReason: "error" };
	}
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}
	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname
			.toLowerCase()
			.match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function createImageBlock(mimeType: string, data: string): { image: unknown } {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}
	return { source: { bytes: base64ToBytes(data) }, format } as unknown as { image: unknown };
}

function base64ToBytes(data: string): Uint8Array {
	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

function decodeRedactedContent(signature: string | undefined): Uint8Array | undefined {
	if (!signature) return undefined;
	try {
		return base64ToBytes(signature);
	} catch {
		return undefined;
	}
}

function extractBedrockErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !error.name.endsWith("Exception")) return undefined;
	return normalizeDiagnosticValue(error.name);
}

function flushRedactedContent(block: Block): void {
	if (block.type !== "thinking" || !block.redactedChunks) return;
	block.thinkingSignature = bytesToBase64(block.redactedChunks);
	delete block.redactedChunks;
}

function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	return (
		options.region ||
		getProviderEnvValue("AWS_REGION", options.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		undefined
	);
}

function getConfiguredBedrockCredentials(
	env: ProviderEnv | undefined,
): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) {
		return undefined;
	}
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

function shouldUseExplicitBedrockEndpoint(
	baseUrl: string | undefined,
	configuredRegion: string | undefined,
	hasAmbientConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}
	return !configuredRegion && !hasAmbientConfiguredProfile;
}

function resolveCacheRetention(
	cacheRetention: CacheRetention | undefined,
	env: ProviderEnv | undefined,
): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("GAMA_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function bytesToBase64(chunks: Uint8Array[]): string {
	const WINDOW = 0x8000;
	let binary = "";
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i += WINDOW) {
			binary += String.fromCharCode(...chunk.subarray(i, i + WINDOW));
		}
	}
	return btoa(binary);
}

function isSmithyHttpResponse(response: unknown): response is HttpResponse {
	if (!response || typeof response !== "object") return false;
	const candidate = response as HttpResponse;
	return (
		typeof candidate.statusCode === "number" &&
		!!candidate.headers &&
		typeof candidate.headers === "object"
	);
}

function normalizeDiagnosticValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS)
		return undefined;
	return trimmed;
}

function sanitizeBedrockDocument(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sanitizeBedrockDocument);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length > 0)
				.map(([key, nestedValue]) => [key, sanitizeBedrockDocument(nestedValue)]),
		);
	}
	return value;
}

function matchesModel(model: Model<"bedrock-converse-stream">, matches: string[]): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);

	return candidates.some((candidate) => matches.some((match) => candidate.includes(match)));
}

function supportsAdaptiveThinking(model: Model<"bedrock-converse-stream">): boolean {
	return matchesModel(model, ADAPTIVE_THINKING_MATCHES);
}

function addCustomHeadersMiddleware(
	client: BedrockRuntimeClient,
	headers: Record<string, string>,
): void {
	const middleware = (next: (args: unknown) => Promise<unknown>) => async (args: unknown) => {
		applyCustomHeaders(args, headers);
		return next(args);
	};

	client.middlewareStack.add(middleware as never, {
		step: "build",
		name: "gama-ai-custom-headers",
		priority: "low",
	});
}

function applyCustomHeaders(args: unknown, headers: Record<string, string>): void {
	const request = (args as { request?: unknown }).request;
	if (!request || typeof request !== "object" || !("headers" in request)) return;

	const requestHeaders = (request as { headers: Record<string, string> }).headers;

	for (const [key, value] of Object.entries(headers)) {
		if (isReservedHeader(key)) continue;

		requestHeaders[key] = value;
	}
}

function convertToolResultContent(
	content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>,
): unknown[] {
	const result: unknown[] = [];

	for (const c of content) {
		if (c.type === "image") {
			result.push({ image: createImageBlock(c.mimeType!, c.data!) });
			continue;
		}

		const textBlock = createNonBlankTextBlock(c.text!);
		if (textBlock) result.push(textBlock);
	}

	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	return result;
}

function convertToolConfig(
	tools: ReadonlyArray<{ name: string; description: string }> | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	supportsStrictMode: boolean,
) {
	if (!tools?.length) return undefined;
	if (toolChoice === "none") return undefined;
	const bedrockTools = tools.map((tool) => {
		const strict = resolveJsonSchemaStrictSampling(tool as never, supportsStrictMode);
		return {
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: {
					json: getJsonSchemaToolParameters(tool as never, strict),
				},
				...(strict === true ? { strict: true } : {}),
			},
		};
	});
	let bedrockToolChoice: unknown;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}
	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function appendBedrockFailureDiagnostic(
	output: AssistantMessage,
	error: unknown,
	fallbackRequestId: string | undefined,
): void {
	const metadata = (error as SdkErrorMetadata | undefined)?.$metadata;
	const details: JsonObject = {};

	if (typeof metadata?.httpStatusCode === "number") {
		details.status = metadata.httpStatusCode;
	}

	const errorCode = extractBedrockErrorCode(error);
	if (errorCode !== undefined) details.errorCode = errorCode;

	const requestId = normalizeDiagnosticValue(metadata?.requestId) ?? fallbackRequestId;
	if (requestId !== undefined) details.requestId = requestId;

	if (Object.keys(details).length === 0) return;

	appendAssistantMessageDiagnostic(output, {
		type: "bedrock_response_failure",
		timestamp: Date.now(),
		details,
	});
}

export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model,
	context,
	options = {},
) => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream",
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
		const blocks = output.content as Block[];

		const optionsProfile = options.profile || options.env?.AWS_PROFILE;
		const config: Record<string, unknown> = {
			profile: optionsProfile || getProviderEnvValue("AWS_PROFILE", options.env),
		};

		const configuredRegion = getConfiguredBedrockRegion(options);
		const hasAmbientConfiguredProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
		const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
		const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
			model.baseUrl,
			configuredRegion,
			hasAmbientConfiguredProfile,
		);

		if (useExplicitEndpoint) {
			config.endpoint = model.baseUrl;
		}

		const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
		const bearerToken =
			options.bearerToken ||
			options.apiKey ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) ||
			undefined;
		const useBearerToken = bearerToken !== undefined && !skipAuth;

		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			const arnRegionMatch = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
			if (arnRegionMatch) {
				config.region = arnRegionMatch[1];
			} else if (configuredRegion) {
				config.region = configuredRegion;
			} else if (endpointRegion && useExplicitEndpoint) {
				config.region = endpointRegion;
			} else if (!hasAmbientConfiguredProfile) {
				config.region = "us-east-1";
			}

			if (skipAuth) {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			const credentials = getConfiguredBedrockCredentials(options.env);
			if (!skipAuth && credentials && !optionsProfile) {
				config.credentials = credentials;
			}

			const proxyUrl = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
			if (proxyUrl) {
				config.requestHandler = new NodeHttpHandler({
					httpAgent: new HttpProxyAgent(proxyUrl),
					httpsAgent: new HttpsProxyAgent(proxyUrl),
				});
			} else if (getProviderEnvValue("AWS_BEDROCK_FORCE_HTTP1", options.env) === "1") {
				config.requestHandler = new NodeHttpHandler();
			}
		} else {
			config.region =
				configuredRegion ||
				(endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) ||
				"us-east-1";
		}

		if (useBearerToken) {
			config.token = { token: bearerToken };
			config.authSchemePreference = ["httpBearerAuth"];
		}

		let responseRequestId: string | undefined;

		try {
			const supportsStrictMode = model.compat?.supportsStrictMode ?? false;
			const client = new BedrockRuntimeClient(config as BedrockRuntimeClientConfig);
			let observedRawResponse = false;

			if (options.onResponse) {
				addResponseHeadersMiddleware(client, options.onResponse, model, () => {
					observedRawResponse = true;
				});
			}

			const customHeaders = providerHeadersToRecord(options.headers);
			if (customHeaders) {
				addCustomHeadersMiddleware(client, customHeaders as Record<string, string>);
			}

			const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
			const inferenceMaxTokens =
				options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
			const initialSystemPrompt = initialSystemMessage
				? getSystemMessageText(initialSystemMessage)
				: undefined;

			let commandInput: ConverseStreamCommandInput = {
				modelId: model.id,
				messages: convertMessages(
					normalizedContext,
					model,
					cacheRetention,
					options.env,
				) as never,
				system: buildSystemPrompt(initialSystemPrompt, model, cacheRetention, options.env) as
					| SystemContentBlock[]
					| undefined,
				inferenceConfig: {
					...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig: convertToolConfig(
					getCurrentTools(normalizedContext.messages),
					options.toolChoice,
					supportsStrictMode,
				) as never,
				additionalModelRequestFields: buildAdditionalModelRequestFields(
					model,
					options,
				) as DocumentType,
				...(options.requestMetadata !== undefined && {
					requestMetadata: options.requestMetadata,
				}),
			};

			const nextCommandInput = await options?.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				commandInput = nextCommandInput as ConverseStreamCommandInput;
			}

			const command = new ConverseStreamCommand(commandInput);
			const response = await client.send(command, { abortSignal: options.signal });
			responseRequestId = normalizeDiagnosticValue(response.$metadata.requestId);

			if (!observedRawResponse && response.$metadata.httpStatusCode !== undefined) {
				const responseHeaders: Record<string, string> = {};
				if (response.$metadata.requestId) {
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				await options?.onResponse?.(
					{ status: response.$metadata.httpStatusCode, headers: responseHeaders },
					model,
				);
			}

			for await (const item of response.stream!) {
				await options.onProviderStreamEvent?.(item, model);
				if (item.messageStart) {
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						throw new Error(
							"Unexpected assistant message start but got user message start instead",
						);
					}
					stream.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
				} else if (item.messageStop) {
					output.rawStopReason = item.messageStop.stopReason;
					const { stopReason, errorMessage } = mapStopReason(item.messageStop.stopReason);
					output.stopReason = stopReason;
					if (errorMessage) {
						output.errorMessage = errorMessage;
					}
				} else if (item.metadata) {
					handleMetadata(item.metadata, model, output);
				} else if (item.internalServerException) {
					throw item.internalServerException;
				} else if (item.modelStreamErrorException) {
					throw item.modelStreamErrorException;
				} else if (item.validationException) {
					throw item.validationException;
				} else if (item.throttlingException) {
					throw item.throttlingException;
				} else if (item.serviceUnavailableException) {
					throw item.serviceUnavailableException;
				}
			}

			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Bedrock stream ended without a stop reason");
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			for (const block of output.content) {
				finalizeStreamingBlock(block as Block);
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				finalizeStreamingBlock(block as Block);
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatBedrockError(error);
			if (output.stopReason === "error") {
				appendBedrockFailureDiagnostic(output, error, responseRequestId);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

function addResponseHeadersMiddleware(
	client: BedrockRuntimeClient,
	onResponse: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>,
	model: Model<Api>,
	onObserved: () => void,
): void {
	const middleware =
		(next: (args: unknown) => Promise<{ response?: unknown }>) => async (args: unknown) => {
			const result = await next(args);
			const providerResponse = toProviderResponse(result.response);
			if (providerResponse) {
				onObserved();
				await onResponse(providerResponse, model);
			}
			return result;
		};
	client.middlewareStack.add(middleware as never, {
		step: "deserialize",
		name: "gama-ai-response-headers",
	});
}

function isGovCloudBedrockTarget(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}
	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

function handleContentBlockStart(
	event: {
		contentBlockIndex?: number;
		start?: { toolUse?: { toolUseId?: string; name?: string } };
	},
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockStop(
	event: { contentBlockIndex?: number },
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;

	delete block.index;

	switch (block.type) {
		case "text":
			stream.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: output,
			});
			break;
		case "thinking":
			flushRedactedContent(block);
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: output,
			});
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson!);
			delete block.partialJson;
			stream.push({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: block,
				partial: output,
			});
			break;
	}
}

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	return matchesModel(model, ADVANCED_THINKING_MATCHES);
}

function supportsThinkingBlockBinding(model: Model<"bedrock-converse-stream">): boolean {
	return matchesModel(model, ADVANCED_THINKING_MATCHES);
}

function formatBedrockError(error: unknown): string {
	const norm = normalizeProviderError(error);
	const core =
		!norm.messageCarriesBody && norm.status !== undefined && norm.body !== undefined
			? `${norm.status}: ${norm.body}`
			: norm.message;
	const dataRetentionHint = /data retention mode/i.test(core)
		? ` See ${BEDROCK_DATA_RETENTION_DOCS_URL} for supported data retention modes.`
		: "";
	if (error instanceof BedrockRuntimeServiceException) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${core}${dataRetentionHint}`;
	}
	return `${core}${dataRetentionHint}`;
}

function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env: ProviderEnv | undefined,
): unknown[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: unknown[] = [{ text: sanitizeSurrogates(systemPrompt) }];
	if (cacheRetention === "none" || !supportsPromptCaching(model, env)) return blocks;

	blocks.push({
		cachePoint: {
			type: CachePointType.DEFAULT,
			...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
		},
	});

	return blocks;
}

export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: (options as BedrockOptions | undefined)?.toolChoice,
	};

	if (!options?.reasoning) {
		return stream(model, context, { ...base, reasoning: undefined });
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model)) {
			return stream(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			});
		}

		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);
		const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

		return stream(model, context, {
			...base,
			maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning) as string]: Math.min(
					adjusted.thinkingBudget,
					Math.max(0, maxTokens - 1024),
				),
			},
		});
	}

	return stream(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	});
};

type BedrockEffort = "low" | "medium" | "high" | "xhigh";

function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: ThinkingLevel | undefined,
): BedrockEffort {
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as BedrockEffort;
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

function handleMetadata(
	event: {
		usage?: {
			inputTokens?: number;
			outputTokens?: number;
			cacheReadInputTokens?: number;
			cacheWriteInputTokens?: number;
			cacheDetails?: Array<{ ttl?: string; inputTokens?: number }>;
			totalTokens?: number;
		};
	},
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;

		output.usage.cacheWrite1h = event.usage.cacheDetails?.reduce(
			(total, detail) =>
				total + (detail.ttl === CacheTTL.ONE_HOUR ? (detail.inputTokens ?? 0) : 0),
			0,
		);

		output.usage.totalTokens =
			event.usage.totalTokens ||
			output.usage.input +
				output.usage.output +
				output.usage.cacheRead +
				output.usage.cacheWrite;

		calculateCost(model, output.usage);
	}
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, unknown> | undefined {
	if (!options.reasoning || !model.reasoning) return undefined;
	if (!isAnthropicClaudeModel(model)) return undefined;

	const display = getThinkingDisplay(model, options);
	const useBlockBinding = display !== undefined && supportsThinkingBlockBinding(model);
	const adaptive = supportsAdaptiveThinking(model);

	const fields = adaptive
		? buildAdaptiveFields(model, options.reasoning, display, useBlockBinding)
		: buildBudgetFields(options.reasoning, options.thinkingBudgets, display);

	const interleaved = options.interleavedThinking ?? true;
	if (!adaptive && interleaved) {
		fields.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	}

	return fields;
}

function getThinkingDisplay(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): string | undefined {
	if (isGovCloudBedrockTarget(model, options)) return undefined;

	return options.thinkingDisplay ?? "summarized";
}

function buildAdaptiveFields(
	model: Model<"bedrock-converse-stream">,
	reasoning: ThinkingLevel,
	display: string | undefined,
	useBlockBinding: boolean,
): Record<string, unknown> {
	const blockBinding = useBlockBinding
		? { block_binding: { prefix_mismatch_behavior: "drop_block" } }
		: {};

	return {
		thinking: {
			type: "adaptive",
			...(display === undefined ? {} : { display }),
			...blockBinding,
		},
		output_config: { effort: mapThinkingLevelToEffort(model, reasoning) },
		...(useBlockBinding ? { anthropic_beta: [THINKING_BINDING_CONTROLS_BETA] } : {}),
	};
}

function buildBudgetFields(
	reasoning: ThinkingLevel,
	budgets: ThinkingBudgets | undefined,
	display: string | undefined,
): Record<string, unknown> {
	const level = reasoning === "xhigh" || reasoning === "max" ? "high" : reasoning;
	const budget = budgets?.[level] ?? DEFAULT_THINKING_BUDGETS[reasoning];

	return {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
			...(display === undefined ? {} : { display }),
		},
	};
}

function supportsPromptCaching(
	model: Model<"bedrock-converse-stream">,
	env: ProviderEnv | undefined,
): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	const hasClaudeRef = candidates.some((s) => s.includes("claude"));

	if (!hasClaudeRef) {
		if (getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1") return true;
		return false;
	}

	const hasNewerFamily = candidates.some(
		(s) => s.includes("fable-5") || s.includes("opus-5") || s.includes("sonnet-5"),
	);
	if (hasNewerFamily) return true;

	if (candidates.some((s) => s.includes("-4-"))) return true;
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;

	return false;
}

function handleContentBlockDelta(
	event: {
		contentBlockIndex?: number;
		delta?: {
			text?: string;
			toolUse?: { input?: string };
			reasoningContent?: {
				text?: string;
				signature?: string;
				redactedContent?: Uint8Array;
			};
		};
	},
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex;
	const delta = event.delta;

	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index]!;
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({
				type: "text_delta",
				contentIndex: index,
				delta: delta.text,
				partial: output,
			});
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({
			type: "toolcall_delta",
			contentIndex: index,
			delta: delta.toolUse.input || "",
			partial: output,
		});
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = {
				type: "thinking",
				thinking: "",
				thinkingSignature: "",
				index: contentBlockIndex,
			};
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex]!;
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}

			if (delta.reasoningContent.signature && !thinkingBlock.redacted) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}

			if (delta.reasoningContent.redactedContent?.length) {
				if (!thinkingBlock.redacted) {
					thinkingBlock.redacted = true;
					thinkingBlock.thinkingSignature = "";
					thinkingBlock.thinking += REDACTED_THINKING_PLACEHOLDER;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingIndex,
						delta: REDACTED_THINKING_PLACEHOLDER,
						partial: output,
					});
				}
				thinkingBlock.redactedChunks ??= [];
				thinkingBlock.redactedChunks.push(delta.reasoningContent.redactedContent);
			}
		}
	}
}

function convertMessages(
	context: TranscriptContext,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env: ProviderEnv | undefined,
): unknown[] {
	const messages = transformMessages(
		withoutInitialSystemMessage(context.messages),
		model,
		normalizeToolCallId,
	);
	const result: Array<{ role: string; content: unknown[] }> = [];

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;

		if (message.role === "user") {
			result.push({ role: ConversationRole.USER, content: toUserContent(message) });
			continue;
		}

		if (message.role === "assistant") {
			const content = toAssistantContent(model, message);
			if (content.length === 0) continue;

			result.push({ role: ConversationRole.ASSISTANT, content });
			continue;
		}

		if (message.role !== "toolResult") continue;

		const toolResults: unknown[] = [toToolResultBlock(message)];

		let next = i + 1;
		while (next < messages.length && messages[next]!.role === "toolResult") {
			toolResults.push(toToolResultBlock(messages[next] as ToolResultMessage));
			next++;
		}

		i = next - 1;
		result.push({ role: ConversationRole.USER, content: toolResults });
	}

	addCachePoint(result, model, cacheRetention, env);

	return result;
}

function toUserContent(message: UserMessage): unknown[] {
	if (typeof message.content === "string") return [createRequiredTextBlock(message.content)];

	const content: unknown[] = [];

	for (const block of message.content) {
		if (block.type === "text") {
			const textBlock = createNonBlankTextBlock(block.text);
			if (textBlock) content.push(textBlock);

			continue;
		}

		if (block.type === "image") {
			content.push({ image: createImageBlock(block.mimeType, block.data) });
		}
	}

	return content.length > 0 ? content : [{ text: EMPTY_TEXT_PLACEHOLDER }];
}

function toAssistantContent(
	model: Model<"bedrock-converse-stream">,
	message: AssistantMessage,
): unknown[] {
	const content: unknown[] = [];

	for (const block of message.content) {
		if (block.type === "text") {
			const textBlock = createNonBlankTextBlock(block.text);
			if (textBlock) content.push(textBlock);

			continue;
		}

		if (block.type === "toolCall") {
			content.push({
				toolUse: {
					toolUseId: block.id,
					name: block.name,
					input: sanitizeBedrockDocument(block.arguments),
				},
			});
			continue;
		}

		if (block.type === "thinking") {
			pushThinkingContent(content, model, block);
		}
	}

	return content;
}

function pushThinkingContent(
	content: unknown[],
	model: Model<"bedrock-converse-stream">,
	block: ThinkingContent,
): void {
	if (block.redacted) {
		const redactedContent = decodeRedactedContent(block.thinkingSignature);
		if (redactedContent?.length) content.push({ reasoningContent: { redactedContent } });

		return;
	}

	const thinking = sanitizeSurrogates(block.thinking);
	if (thinking.trim().length === 0) return;

	const signature = block.thinkingSignature;
	if (!supportsThinkingSignature(model)) {
		content.push({ reasoningContent: { reasoningText: { text: thinking } } });
		return;
	}

	if (!signature || signature.trim().length === 0) {
		content.push({ text: thinking });
		return;
	}

	content.push({ reasoningContent: { reasoningText: { text: thinking, signature } } });
}

function toToolResultBlock(message: ToolResultMessage): unknown {
	return {
		toolResult: {
			toolUseId: message.toolCallId,
			content: convertToolResultContent(message.content as never),
			status: message.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
		},
	};
}

function addCachePoint(
	messages: Array<{ role: string; content: unknown[] }>,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env: ProviderEnv | undefined,
): void {
	if (cacheRetention === "none") return;
	if (!supportsPromptCaching(model, env)) return;
	if (messages.length === 0) return;

	const lastMessage = messages[messages.length - 1]!;
	if (lastMessage.role !== ConversationRole.USER) return;

	lastMessage.content.push({
		cachePoint: {
			type: CachePointType.DEFAULT,
			...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
		},
	});
}
