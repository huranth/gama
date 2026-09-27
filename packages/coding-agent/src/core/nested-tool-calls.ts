import type {
	AgentTool,
	AgentToolCall,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@huranth/gama-agent-core";
import type {
	JsonObject,
	NestedToolCallRecord,
	NestedToolCalls,
	TextContent,
	Usage,
} from "@huranth/gama-ai";
import { combineUsage } from "./usage-totals.ts";

export interface NestedCallSummary {
	calls: NestedToolCalls | undefined;
	usage: Usage | undefined;
}

export interface NestedToolCallOptions {
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
}

export type NestedToolExecutionEvent =
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult: AgentToolResult<unknown>;
			parentToolCallId: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			parentToolCallId: string;
	  };

export interface NestedToolCallHost {
	getTools(): readonly AgentTool[];
	isSequential(): boolean;
	runToolCall(
		toolCall: AgentToolCall,
		parentToolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: (partialResult: AgentToolResult<unknown>) => Promise<void>,
	): Promise<AgentToolCallOutcome>;
	emit(event: NestedToolExecutionEvent): Promise<void>;
}

interface CallScope {
	recorder: NestedCallRecorder;
	nextId: number;
	holdsQueue: boolean;
}

export const NESTED_CALL_LIMITS = {
	maxCalls: 256,
	maxArgumentBytesPerCall: 8 * 1024,
	maxArgumentBytesTotal: 32 * 1024,
	maxErrorChars: 500,
} as const;

const encoder = new TextEncoder();

function textOf(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export class NestedCallRecorder {
	private readonly calls: NestedToolCallRecord[] = [];
	private readonly startedAt = new Map<NestedToolCallRecord, number>();
	private complete = true;
	private argumentBytes = 0;
	private usage: Usage | undefined;

	start(toolCall: AgentToolCall): NestedToolCallRecord | undefined {
		if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
			this.complete = false;
			return undefined;
		}
		const record: NestedToolCallRecord = {
			id: toolCall.id,
			name: toolCall.name,
			status: "unfinished",
		};
		const json = JSON.stringify(toolCall.arguments ?? {});
		const bytes = encoder.encode(json).length;
		if (
			bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
			this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
		) {
			record.argumentsBytes = bytes;
			this.complete = false;
		} else {
			record.arguments = JSON.parse(json) as JsonObject;
			this.argumentBytes += bytes;
		}
		this.calls.push(record);
		this.startedAt.set(record, performance.now());
		return record;
	}

	finish(record: NestedToolCallRecord | undefined, isError: boolean, errorText: string): void {
		if (!record) return;
		record.status = isError ? "error" : "ok";
		record.durationMs = Math.round(
			performance.now() - (this.startedAt.get(record) ?? performance.now()),
		);
		this.startedAt.delete(record);
		if (isError && errorText) record.error = errorText.slice(0, NESTED_CALL_LIMITS.maxErrorChars);
	}

	addUsage(usage: Usage): void {
		this.usage = this.usage ? combineUsage(this.usage, usage) : usage;
	}

	get totalUsage(): Usage | undefined {
		return this.usage;
	}

	snapshot(): NestedToolCalls | undefined {
		if (this.calls.length === 0 && this.complete) return undefined;
		const calls = this.calls.map((call) => ({ ...call }));
		return {
			calls,
			complete: this.complete && calls.every((call) => call.status !== "unfinished"),
		};
	}
}

export class NestedToolCallRunner {
	private readonly host: NestedToolCallHost;
	private readonly scopes = new Map<string, CallScope>();
	private queueTail: Promise<void> = Promise.resolve();

	constructor(host: NestedToolCallHost) {
		this.host = host;
	}

	async execute(
		callerId: string,
		name: string,
		args: unknown,
		options: NestedToolCallOptions = {},
	): Promise<AgentToolCallOutcome> {
		const scope = this.getScope(callerId);
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: `${callerId}/${scope.nextId++}`,
			name,
			arguments: (args ?? {}) as AgentToolCall["arguments"],
		};
		const record = scope.recorder.start(toolCall);
		await this.host.emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: name,
			args: toolCall.arguments,
			parentToolCallId: callerId,
		});

		const sequential = this.isSequential(name);
		const release = await this.acquireQueue(scope, sequential);

		this.scopes.set(toolCall.id, {
			recorder: scope.recorder,
			nextId: 1,
			holdsQueue: scope.holdsQueue || release !== undefined,
		});

		let outcome: AgentToolCallOutcome;
		try {
			outcome = await this.host.runToolCall(
				toolCall,
				callerId,
				options.signal,
				async (partialResult) => {
					options.onUpdate?.(partialResult);
					await this.host.emit({
						type: "tool_execution_update",
						toolCallId: toolCall.id,
						toolName: name,
						args: toolCall.arguments,
						partialResult,
						parentToolCallId: callerId,
					});
				},
			);
		} finally {
			this.scopes.delete(toolCall.id);
			release?.();
		}

		scope.recorder.finish(record, outcome.isError, textOf(outcome.result));
		if (outcome.result.usage) scope.recorder.addUsage(outcome.result.usage);

		await this.host.emit({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: name,
			result: outcome.result,
			isError: outcome.isError,
			parentToolCallId: callerId,
		});

		return outcome;
	}

	takeRecord(toolCallId: string): NestedCallSummary | undefined {
		const scope = this.scopes.get(toolCallId);
		this.scopes.delete(toolCallId);
		if (!scope) return undefined;
		return { calls: scope.recorder.snapshot(), usage: scope.recorder.totalUsage };
	}

	clear(): void {
		this.scopes.clear();
	}

	private getScope(callerId: string): CallScope {
		const existing = this.scopes.get(callerId);
		if (existing) return existing;

		const scope: CallScope = {
			recorder: new NestedCallRecorder(),
			nextId: 1,
			holdsQueue: false,
		};
		this.scopes.set(callerId, scope);

		return scope;
	}

	private isSequential(name: string): boolean {
		if (this.host.isSequential()) return true;

		const tool = this.host.getTools().find((entry) => entry.name === name);

		return tool?.executionMode === "sequential";
	}

	private async acquireQueue(
		scope: CallScope,
		sequential: boolean,
	): Promise<(() => void) | undefined> {
		if (!sequential || scope.holdsQueue) return undefined;

		const previous = this.queueTail;
		let release: (() => void) | undefined;
		this.queueTail = new Promise((resolve) => {
			release = resolve;
		});
		await previous;

		return release;
	}
}
