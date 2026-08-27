import type {
	AssistantMessage,
	AssistantMessageEvent,
	CacheRetention,
	JsonObject,
	JsonValue,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
} from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export interface GamaMessagesOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	debug?: boolean;
}

type GamaMessagesUsage = AssistantMessage["usage"];

type GamaMessagesStopReason = AssistantMessage["stopReason"];

export type GamaMessagesRewriteImpact = {
	policyId: string;
	policyVersion: number;
	changed: boolean;
	tokenCountChange: number;
	messageCountChange: number;
	systemPromptChanged: boolean;
};

export type GamaMessagesEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			contentSignature?: string;
			redacted?: boolean;
	  }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			type: "done";
			reason: Extract<GamaMessagesStopReason, "stop" | "length" | "toolUse">;
			usage: GamaMessagesUsage;
			responseId?: string;
			providerThinkingLevel?: string;
			rewrite?: GamaMessagesRewriteImpact;
	  }
	| {
			type: "error";
			reason: Extract<GamaMessagesStopReason, "aborted" | "error">;
			usage: GamaMessagesUsage;
			errorMessage?: string;
			responseId?: string;
			providerThinkingLevel?: string;
			rewrite?: GamaMessagesRewriteImpact;
	  };

type GamaMessagesTerminalEvent =
	| Extract<GamaMessagesEvent, { type: "done" }>
	| Extract<GamaMessagesEvent, { type: "error" }>;

type GamaMessagesErrorBody = {
	error?: {
		message?: unknown;
		code?: unknown;
		details?: unknown;
		[key: string]: unknown;
	};
};

export class GamaMessagesResponseError extends Error {
	code?: string;
	readonly diagnosticDetails: JsonObject;

	constructor(message: string, code: string | undefined, diagnosticDetails: JsonObject) {
		super(message);
		this.name = "GamaMessagesResponseError";
		this.code = code;
		this.diagnosticDetails = diagnosticDetails;
	}
}

function createEmptyUsage(): GamaMessagesUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createGamaMessagesResponseError(
	model: Model<"gama-messages">,
	url: URL,
	response: Response,
	body: string,
): GamaMessagesResponseError {
	const errorBody = parseGamaMessagesErrorBody(body);
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	return new GamaMessagesResponseError(
		formatGamaMessagesResponseError(response, body, errorBody),
		code,
		{
			version: 1,
			provider: model.provider,
			model: model.id,
			url: url.toString(),
			status: response.status,
			statusText: response.statusText,
			...(errorBody?.error === undefined ? {} : { error: errorBody.error as JsonValue }),
			...(errorBody ? {} : { body: truncateDiagnosticString(body) }),
			timestampMs: Date.now(),
		},
	);
}

function formatGamaMessagesResponseError(
	response: Response,
	body: string,
	errorBody: GamaMessagesErrorBody | undefined,
): string {
	const message =
		typeof errorBody?.error?.message === "string" ? errorBody.error.message : undefined;
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	const suffix = message ?? body;
	const codeSuffix = code ? ` (${code})` : "";
	return `${response.status} ${response.statusText}: ${suffix}${codeSuffix}`;
}

function parseGamaMessagesEvent(raw: string): GamaMessagesEvent | undefined {
	// Join data.
	const data = raw
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();

	return data && data !== "[DONE]" ? (JSON.parse(data) as GamaMessagesEvent) : undefined;
}

function appendRewriteDiagnostic(
	message: AssistantMessage,
	rewrite: GamaMessagesRewriteImpact | undefined,
): void {
	if (!rewrite) {
		return;
	}
	appendAssistantMessageDiagnostic(message, {
		type: "gama_messages_rewrite",
		timestamp: Date.now(),
		details: { ...rewrite },
	});
}

function resolveCacheRetention(
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): CacheRetention | undefined {
	if (cacheRetention) {
		return cacheRetention;
	}
	return getProviderEnvValue("GAMA_CACHE_RETENTION", env) === "long" ? "long" : undefined;
}

function parseGamaMessagesErrorBody(body: string): GamaMessagesErrorBody | undefined {
	try {
		const parsed = JSON.parse(body) as GamaMessagesErrorBody | null;
		const error = parsed?.error;
		return parsed && typeof error === "object" && error !== null && !Array.isArray(error)
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function truncateDiagnosticString(value: string): string {
	const maxLength = 8192;
	if (value.length <= maxLength) return value;

	// Surrogate safe.
	const lastCode = value.charCodeAt(maxLength - 1);
	const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? maxLength - 1 : maxLength;
	return `${value.slice(0, end)}…`;
}

function createErrorEvent(
	model: Model<"gama-messages">,
	error: unknown,
	aborted: boolean,
	partial: AssistantMessage | undefined,
): AssistantMessageEvent {
	const reason = aborted ? "aborted" : "error";
	const assistantMessage: AssistantMessage = partial ?? {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: reason,
		timestamp: Date.now(),
	};

	assistantMessage.stopReason = reason;
	assistantMessage.errorMessage = error instanceof Error ? error.message : String(error);

	if (!aborted && error instanceof GamaMessagesResponseError) {
		appendAssistantMessageDiagnostic(
			assistantMessage,
			createAssistantMessageDiagnostic(
				"gama_messages_response_failure",
				error,
				error.diagnosticDetails,
			),
		);
	}

	return { type: "error", reason, error: assistantMessage };
}

function createEventConverter(model: Model<"gama-messages">): {
	convert: (event: GamaMessagesEvent) => AssistantMessageEvent;
	partial: AssistantMessage;
} {
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const toolJson = new Map<number, string>();

	const applyTerminal = (event: GamaMessagesTerminalEvent) => {
		partial.stopReason = event.reason;
		partial.usage = event.usage;
		partial.responseId = event.responseId;

		if (event.type === "error") partial.errorMessage = event.errorMessage;
		if (event.providerThinkingLevel !== undefined) {
			partial.providerThinkingLevel = event.providerThinkingLevel;
		}

		appendRewriteDiagnostic(partial, event.rewrite);
	};

	const convert = (event: GamaMessagesEvent): AssistantMessageEvent => {
		switch (event.type) {
			case "done":
				applyTerminal(event);

				return { type: "done", reason: event.reason, message: partial };
			case "error":
				applyTerminal(event);

				return { type: "error", reason: event.reason, error: partial };
			case "start":
				break;
			case "text_start":
				partial.content[event.contentIndex] = { type: "text", text: "" };
				break;
			case "text_delta":
				(partial.content[event.contentIndex] as { text: string }).text += event.delta;
				break;
			case "text_end":
				Object.assign(partial.content[event.contentIndex] as { text: string }, {
					text: event.content,
					textSignature: event.contentSignature,
				});
				break;
			case "thinking_start":
				partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				(partial.content[event.contentIndex] as { thinking: string }).thinking += event.delta;
				break;
			case "thinking_end":
				Object.assign(partial.content[event.contentIndex] as { thinking: string }, {
					thinking: event.content,
					thinkingSignature: event.contentSignature,
					redacted: event.redacted,
				});
				break;
			case "toolcall_start":
				partial.content[event.contentIndex] = {
					type: "toolCall",
					id: event.id,
					name: event.toolName,
					arguments: {},
				};
				toolJson.set(event.contentIndex, "");
				break;
			case "toolcall_delta": {
				const json = `${toolJson.get(event.contentIndex) ?? ""}${event.delta}`;
				toolJson.set(event.contentIndex, json);
				(partial.content[event.contentIndex] as ToolCall).arguments =
					parseStreamingJson<ToolCall["arguments"]>(json);
				break;
			}
			case "toolcall_end":
				Object.assign(partial.content[event.contentIndex] as ToolCall, event.toolCall);
				toolJson.delete(event.contentIndex);
				return {
					type: "toolcall_end",
					contentIndex: event.contentIndex,
					toolCall: partial.content[event.contentIndex] as ToolCall,
					partial,
				};
		}

		return { ...event, partial } as AssistantMessageEvent;
	};

	return { convert, partial };
}

function buildPayload(
	model: Model<"gama-messages">,
	context: TranscriptContext,
	options?: GamaMessagesOptions,
): unknown {
	return {
		model: model.id,
		context,
		options: {
			temperature: options?.temperature,
			maxTokens: options?.maxTokens,
			reasoning: options?.reasoning,
			cacheRetention: resolveCacheRetention(options?.cacheRetention, options?.env),
			sessionId: options?.sessionId,
			toolChoice: options?.toolChoice,
		},
	};
}

export const stream: StreamFunction<"gama-messages", GamaMessagesOptions> = (
	model,
	context,
	options,
) => {
	const eventStream = new AssistantMessageEventStream();
	const converter = createEventConverter(model);

	void (async () => {
		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key provided for provider "${model.provider}"`);
			}

			const url = new URL(`${model.baseUrl.replace(/\/+$/u, "")}/messages`);
			if (options?.debug) {
				url.searchParams.set("debug", "1");
			}

			let payload: unknown = buildPayload(model, context, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload;
			}

			const response = await (options?.fetch ?? globalThis.fetch)(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					accept: "text/event-stream",
					"content-type": "application/json",
					...providerHeadersToRecord(options?.headers),
				},
				body: JSON.stringify(payload),
				signal: options?.signal,
			});

			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);

			if (!response.ok) {
				const body = await response.text();
				throw createGamaMessagesResponseError(model, url, response, body);
			}
			if (!response.body) {
				throw new Error(`${model.provider} response has no body`);
			}

			for await (const gamaEvent of readGamaMessagesEvents(response.body)) {
				await options?.onProviderStreamEvent?.(gamaEvent, model);
				const event = converter.convert(gamaEvent);
				eventStream.push(event);
				if (event.type === "done" || event.type === "error") {
					return;
				}
			}

			throw new Error(`${model.provider} stream ended without a terminal event`);
		} catch (error) {
			// Keep partial.
			eventStream.push(
				createErrorEvent(model, error, options?.signal?.aborted ?? false, converter.partial),
			);
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"gama-messages", SimpleStreamOptions> = (
	model: Model<"gama-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const extra = options as GamaMessagesOptions | undefined;
	return stream(model, context, {
		...options,
		reasoning: options?.reasoning,
		toolChoice: options?.toolChoice,
		debug: extra?.debug,
	});
};

async function* readGamaMessagesEvents(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<GamaMessagesEvent> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");

			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				const event = parseGamaMessagesEvent(buffer.slice(0, split));
				if (event) {
					yield event;
				}
				buffer = buffer.slice(split + 2);
				split = buffer.indexOf("\n\n");
			}

			if (done) {
				break;
			}
		}

		if (buffer.trim()) {
			const event = parseGamaMessagesEvent(buffer);
			if (event) {
				yield event;
			}
		}
	} finally {
		// Avoid leak
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
