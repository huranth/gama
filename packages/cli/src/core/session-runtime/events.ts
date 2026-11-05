import type { AgentEvent, AgentMessage, ThinkingLevel } from "@huranth/gama-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@huranth/gama-ai/compat";
import type { CompactionResult } from "../comp/index.ts";
import type {
	PluginHost,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnStartEvent,
} from "../ext/index.ts";
import type { HandsEvent } from "../hands.ts";
import type { SessionEntry } from "../sessions.ts";

type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

export type SessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| HandsEvent;

export type AgentSessionEventListener = (event: SessionEvent) => void;

export function emitSessionEvent(
	listeners: readonly AgentSessionEventListener[],
	event: SessionEvent,
): void {
	for (const listener of [...listeners]) {
		listener(event);
	}
}

export function subscribeToSessionEvents(
	listeners: AgentSessionEventListener[],
	listener: AgentSessionEventListener,
): () => void {
	listeners.push(listener);

	return () => {
		const index = listeners.indexOf(listener);
		if (index !== -1) {
			listeners.splice(index, 1);
		}
	};
}

export function makeQueueUpdateEvent(
	steering: readonly string[],
	followUp: readonly string[],
): SessionEvent {
	return {
		type: "queue_update",
		steering: [...steering],
		followUp: [...followUp],
	};
}

export function makeAgentEndEvent(
	event: Extract<AgentEvent, { type: "agent_end" }>,
	willRetry: boolean,
): SessionEvent {
	return { ...event, willRetry };
}

export interface ExtensionEventContext {
	runner: PluginHost;
	turnIndex: number;
	setTurnIndex(turnIndex: number): void;
	dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean>;
	clearBoundaryDispatched(message: AgentMessage): boolean;
	replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void;
}

export async function emitExtensionEvent(
	context: ExtensionEventContext,
	event: AgentEvent,
): Promise<number> {
	let turnIndex = context.turnIndex;

	if (event.type === "agent_start") {
		turnIndex = 0;
		context.setTurnIndex(turnIndex);
		await context.runner.emit({ type: "agent_start" });
	} else if (event.type === "agent_end") {
		await context.runner.emit({ type: "agent_end", messages: event.messages });
	} else if (event.type === "turn_start") {
		const extensionEvent: TurnStartEvent = {
			type: "turn_start",
			turnIndex,
			timestamp: Date.now(),
		};
		await context.runner.emit(extensionEvent);
	} else if (event.type === "turn_end") {
		if (
			event.message.role === "assistant" &&
			!context.clearBoundaryDispatched(event.message)
		) {
			await context.dispatchTurnEndBoundary(event.message, event.toolResults);
		}
		turnIndex++;
		context.setTurnIndex(turnIndex);
	} else if (event.type === "message_start") {
		const extensionEvent: MessageStartEvent = {
			type: "message_start",
			message: event.message,
		};
		await context.runner.emit(extensionEvent);
	} else if (event.type === "message_update") {
		const extensionEvent: MessageUpdateEvent = {
			type: "message_update",
			message: event.message,
			assistantMessageEvent: event.assistantMessageEvent,
		};
		await context.runner.emit(extensionEvent);
	} else if (event.type === "message_end") {
		const extensionEvent: MessageEndEvent = {
			type: "message_end",
			message: event.message,
		};
		const replacement = await context.runner.emitMessageEnd(extensionEvent);
		if (replacement) {
			const normalized =
				(replacement.role === "user" ||
					replacement.role === "assistant" ||
					replacement.role === "toolResult" ||
					replacement.role === "custom") &&
				replacement.content == null
					? ({ ...replacement, content: [] } as AgentMessage)
					: replacement;
			context.replaceMessageInPlace(event.message, normalized);
		}
	} else if (event.type === "tool_execution_start") {
		const extensionEvent: ToolExecutionStartEvent = {
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		};
		await context.runner.emit(extensionEvent);
	} else if (event.type === "tool_execution_update") {
		const extensionEvent: ToolExecutionUpdateEvent = {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
		await context.runner.emit(extensionEvent);
	} else if (event.type === "tool_execution_end") {
		const extensionEvent: ToolExecutionEndEvent = {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		};
		await context.runner.emit(extensionEvent);
	}

	return turnIndex;
}
