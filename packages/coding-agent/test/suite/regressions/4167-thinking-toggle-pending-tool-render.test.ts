import type { AgentMessage } from "@huranth/gama-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@huranth/gama-ai";
import { Container, Text, type TUI } from "@huranth/gama-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/tui/interactive-mode.ts";
import type { ActivityRecord } from "../../../src/modes/tui/parts/activity.ts";
import { initTheme } from "../../../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionItems = (
	this: RenderSessionContextThis,
	items: AgentMessage[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type RenderSessionContextThis = {
	pendingToolCalls: Set<string>;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	activityByToolId: Map<string, { record: ActivityRecord; ticker: unknown }>;
	currentActivity?: unknown;
	trackActivity(toolCallId: string, name: string, args: unknown, timestamp?: number): void;
	addToolLine(line: unknown): void;
	addChatChild(component: unknown): unknown;
	ensureCurrentActivity(): void;
	settleCurrentActivity(): void;
	isSilentTool(toolName: string): boolean;
	updateActivity(toolCallId: string, update: Partial<ActivityRecord>): void;
	toolActivation(toolName: string, toolCallId: string): (() => void) | undefined;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: {
		retryAttempt: number;
		modelRegistry: { find(provider: string, modelId: string): undefined };
	};
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	maybeShowAssistantDiagnostics(message: AssistantMessage): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	renderSessionItems: RenderSessionItems;
	handleToolExecutionEnd(event: AgentSessionEvent): void;
};

type RenderSessionEntries = (
	this: RenderSessionContextThis,
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	return {
		pendingToolCalls: new Set<string>(),
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		activityByToolId: new Map<string, { record: ActivityRecord; ticker: unknown }>(),
		trackActivity: (
			InteractiveMode.prototype as unknown as {
				trackActivity: RenderSessionContextThis["trackActivity"];
			}
		).trackActivity,
		updateActivity: (
			InteractiveMode.prototype as unknown as {
				updateActivity: RenderSessionContextThis["updateActivity"];
			}
		).updateActivity,
		addToolLine: (
			InteractiveMode.prototype as unknown as {
				addToolLine: RenderSessionContextThis["addToolLine"];
			}
		).addToolLine,
		addChatChild: (
			InteractiveMode.prototype as unknown as {
				addChatChild: RenderSessionContextThis["addChatChild"];
			}
		).addChatChild,
		ensureCurrentActivity: (
			InteractiveMode.prototype as unknown as {
				ensureCurrentActivity: RenderSessionContextThis["ensureCurrentActivity"];
			}
		).ensureCurrentActivity,
		settleCurrentActivity: (
			InteractiveMode.prototype as unknown as {
				settleCurrentActivity: RenderSessionContextThis["settleCurrentActivity"];
			}
		).settleCurrentActivity,
		isSilentTool: (
			InteractiveMode.prototype as unknown as {
				isSilentTool: RenderSessionContextThis["isSilentTool"];
			}
		).isSilentTool,
		toolActivation: (
			InteractiveMode.prototype as unknown as {
				toolActivation: RenderSessionContextThis["toolActivation"];
			}
		).toolActivation,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: { retryAttempt: 0, modelRegistry: { find: () => undefined } },
		toolOutputExpanded: false,
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		maybeShowAssistantDiagnostics: vi.fn(),
		renderSessionItems: (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems }
		).renderSessionItems,
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
		handleToolExecutionEnd: (
			InteractiveMode.prototype as unknown as {
				handleToolExecutionEnd: RenderSessionContextThis["handleToolExecutionEnd"];
			}
		).handleToolExecutionEnd,
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionEntries", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent })
			.handleEvent;

		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingToolCalls.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.pendingToolCalls.has(TOOL_CALL_ID)).toBe(false);
		expect(fakeThis.activityByToolId.get(TOOL_CALL_ID)?.record.result?.content).toEqual([
			{ type: "text", text: "FINAL_RESULT" },
		]);
		expect(renderChat(fakeThis.chatContainer)).toContain(TOOL_NAME);
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;

		renderSessionEntries.call(
			fakeThis,
			createSessionEntries([
				createAssistantToolCallMessage(),
				createToolResultMessage("HISTORICAL_RESULT"),
			]),
		);

		expect(fakeThis.pendingToolCalls.size).toBe(0);
		expect(fakeThis.activityByToolId.get(TOOL_CALL_ID)?.record.result?.content).toEqual([
			{ type: "text", text: "HISTORICAL_RESULT" },
		]);
		expect(renderChat(fakeThis.chatContainer)).toContain(TOOL_NAME);
	});
});
