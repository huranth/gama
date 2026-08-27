import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	ThinkingLevel as GoogleSdkThinkingLevel,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import { clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	GoogleApiThinkingLevel,
	ImageContent,
	Model,
	ResolvedGoogleThinkingLevel,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	UserMessage,
} from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { collapseSystemMessages, withoutInitialSystemMessage } from "../utils/transcript.ts";
import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "../types.ts";

interface GoogleBudgetEntry {
	match: string;
	budgets: Record<ResolvedGoogleThinkingLevel, number>;
}

const GOOGLE_SDK_THINKING_LEVEL_MAP: Record<GoogleApiThinkingLevel, GoogleSdkThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: GoogleSdkThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: GoogleSdkThinkingLevel.MINIMAL,
	LOW: GoogleSdkThinkingLevel.LOW,
	MEDIUM: GoogleSdkThinkingLevel.MEDIUM,
	HIGH: GoogleSdkThinkingLevel.HIGH,
};

const GOOGLE_BUDGETS: GoogleBudgetEntry[] = [
	{ match: "2.5-pro", budgets: { minimal: 128, low: 2048, medium: 8192, high: 32768 } },
	{ match: "2.5-flash-lite", budgets: { minimal: 512, low: 2048, medium: 8192, high: 24576 } },
	{ match: "2.5-flash", budgets: { minimal: 128, low: 2048, medium: 8192, high: 24576 } },
];

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
]);

export function toGoogleSdkThinkingLevel(level: GoogleApiThinkingLevel): GoogleSdkThinkingLevel {
	return GOOGLE_SDK_THINKING_LEVEL_MAP[level];
}

export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

export function retainThoughtSignature(
	existing: string | undefined,
	incoming: string | undefined,
): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;

	return existing;
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;

	return Number.parseInt(match[1], 10);
}

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;

	return base64SignaturePattern.test(signature);
}

function resolveThoughtSignature(
	isSameProviderAndModel: boolean,
	signature: string | undefined,
): string | undefined {
	if (!isSameProviderAndModel) return undefined;
	if (!isValidThoughtSignature(signature)) return undefined;

	return signature;
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	if (majorVersion === undefined) return true;

	return majorVersion >= 3;
}

export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	if (majorVersion === undefined) return false;

	return majorVersion >= 3;
}

export function usesGoogleThinkingLevel<T extends GoogleApiType>(model: Model<T>): boolean {
	const id = model.id.toLowerCase();
	const isGemini3LevelModel = /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id);
	const isGemma4 = /gemma-?4/.test(id);

	return (
		isGemini3LevelModel ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		isGemma4
	);
}

export function requiresToolCallId(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);

	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(majorVersion !== undefined && majorVersion >= 3)
	);
}

export function resolveGoogleThinkingLevel<T extends GoogleApiType>(
	model: Model<T>,
	level: ThinkingLevel,
): ResolvedGoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;

	switch (resolvedLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return resolvedLevel;
		default:
			throw new Error(
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ` +
					`${level} -> ${String(mapped)}`,
			);
	}
}

export function toGoogleThinkingLevel(level: ResolvedGoogleThinkingLevel): GoogleApiThinkingLevel {
	switch (level) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

export function getDisabledGoogleThinkingConfig<T extends GoogleApiType>(
	model: Model<T>,
): ThinkingConfig {
	if (!usesGoogleThinkingLevel(model)) return { thinkingBudget: 0 };

	const fallback = clampThinkingLevel(model, "off");
	if (fallback === "off") return { thinkingBudget: 0 };

	const resolvedLevel = resolveGoogleThinkingLevel(model, fallback);
	const apiLevel = toGoogleThinkingLevel(resolvedLevel);

	return { thinkingLevel: toGoogleSdkThinkingLevel(apiLevel) };
}

export function resolveGoogleBudget(
	modelId: string,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	const customBudget = customBudgets?.[level];
	if (customBudget !== undefined) return customBudget;

	const entry = GOOGLE_BUDGETS.find((item) => modelId.includes(item.match));
	if (!entry) return -1;

	return entry.budgets[level];
}

export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;

	const functionDeclarations = tools.map((tool) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const parameters = getJsonSchemaToolParameters(tool, strict);
		const schema = useParameters
			? { parameters: sanitizeForOpenApi(parameters) }
			: { parametersJsonSchema: parameters };

		return { name: tool.name, description: tool.description, ...schema };
	});

	return [{ functionDeclarations }];
}

export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	const useStrictMode = tools.some(
		(tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true,
	);

	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}

	if (useStrictMode) return FunctionCallingConfigMode.VALIDATED;

	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.TOO_MANY_TOOL_CALLS:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const unhandled: never = reason;

			throw new Error(`Unhandled stop reason: ${unhandled}`);
		}
	}
}

export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}

	return result;
}

export function convertMessages<T extends GoogleApiType>(
	model: Model<T>,
	context: TranscriptContext,
): Content[] {
	const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages);
	const contents: Content[] = [];

	for (const message of transformMessages(conversation, model, toolCallIdNormalizer(model))) {
		if (message.role === "user") pushUserContent(contents, message);
		else if (message.role === "assistant") pushAssistantContent(contents, model, message);
		else if (message.role === "toolResult") pushToolResult(contents, model, message);
	}

	return contents;
}

function toolCallIdNormalizer<T extends GoogleApiType>(model: Model<T>): (id: string) => string {
	if (!requiresToolCallId(model.id)) return (id) => id;

	return (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function pushUserContent(contents: Content[], message: UserMessage): void {
	if (typeof message.content === "string") {
		contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(message.content) }] });

		return;
	}

	const parts: Part[] = message.content.map((item) => {
		if (item.type === "text") {
			return { text: sanitizeSurrogates(item.text) };
		}

		return { inlineData: { mimeType: item.mimeType, data: item.data } };
	});

	if (parts.length === 0) return;

	contents.push({ role: "user", parts });
}

function pushAssistantContent<T extends GoogleApiType>(
	contents: Content[],
	model: Model<T>,
	message: AssistantMessage,
): void {
	const parts: Part[] = [];
	const isSameProviderAndModel = message.provider === model.provider && message.model === model.id;

	for (const block of message.content) {
		if (block.type === "text") {
			const signature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
			if (isBlank(block.text) && !signature) continue;

			parts.push({
				text: sanitizeSurrogates(block.text),
				...(signature && { thoughtSignature: signature }),
			});
		} else if (block.type === "thinking") {
			pushThinkingPart(parts, block, isSameProviderAndModel);
		} else if (block.type === "toolCall") {
			const signature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
			const id = requiresToolCallId(model.id) ? { id: block.id } : {};

			parts.push({
				functionCall: { name: block.name, args: block.arguments ?? {}, ...id },
				...(signature && { thoughtSignature: signature }),
			});
		}
	}

	if (parts.length === 0) return;

	contents.push({ role: "model", parts });
}

function pushThinkingPart(
	parts: Part[],
	block: ThinkingContent,
	isSameProviderAndModel: boolean,
): void {
	// Plain text
	if (!isSameProviderAndModel) {
		if (isBlank(block.thinking)) return;

		parts.push({ text: sanitizeSurrogates(block.thinking) });

		return;
	}

	const signature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
	if (isBlank(block.thinking) && !signature) return;

	parts.push({
		thought: true,
		text: sanitizeSurrogates(block.thinking),
		...(signature && { thoughtSignature: signature }),
	});
}

function pushToolResult<T extends GoogleApiType>(
	contents: Content[],
	model: Model<T>,
	message: ToolResultMessage,
): void {
	const textResult = message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	const imageParts = toImageParts(model, message);
	const hasText = textResult.length > 0;
	const hasImages = imageParts.length > 0;
	const isMultimodal = supportsMultimodalFunctionResponse(model.id);
	const includeId = requiresToolCallId(model.id);

	const value = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

	const part: Part = {
		functionResponse: {
			name: message.toolName,
			response: message.isError ? { error: value } : { output: value },
			...(hasImages && isMultimodal && { parts: imageParts }),
			...(includeId ? { id: message.toolCallId } : {}),
		},
	};

	attachToolResult(contents, part);

	if (hasImages && !isMultimodal) {
		contents.push({
			role: "user",
			parts: [{ text: "Tool result image:" }, ...imageParts],
		});
	}
}

function attachToolResult(contents: Content[], part: Part): void {
	const last = contents[contents.length - 1];
	const parts = last?.role === "user" ? last.parts : undefined;

	if (parts?.some((item) => item.functionResponse)) {
		parts.push(part);

		return;
	}

	contents.push({ role: "user", parts: [part] });
}

function toImageParts<T extends GoogleApiType>(
	model: Model<T>,
	message: ToolResultMessage,
): Part[] {
	if (!model.input.includes("image")) return [];

	return message.content
		.filter((part): part is ImageContent => part.type === "image")
		.map((part) => ({ inlineData: { mimeType: part.mimeType, data: part.data } }));
}

function isBlank(text: string | undefined): boolean {
	if (!text) return true;

	return text.trim() === "";
}

export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = undefined;
				}

				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
}
