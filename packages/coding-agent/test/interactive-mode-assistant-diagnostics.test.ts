import type { AssistantMessage } from "@huranth/gama-ai";
import { Container } from "@huranth/gama-tui";
import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";
import { initTheme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "survived" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-fable-5-1",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	diagnostics: [
		{
			type: "anthropic_input_transformations",
			timestamp: 1,
			details: {
				transformations: [
					{
						type: "thinking_dropped",
						path: "messages.2.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.5.content.0",
						reason: "prefix_binding_mismatch",
					},
					{
						type: "thinking_dropped",
						path: "messages.8.content.0",
						reason: "prefix_binding_mismatch",
					},
				],
			},
		},
	],
};

type NoticeContext = {
	chatContainer: Container;
	sessionManager: { getBranch(): Array<{ type: "message"; message: AssistantMessage }> };
};

const maybeShowThinkingDropNotice = Reflect.get(
	InteractiveMode.prototype,
	"maybeShowThinkingDropNotice",
) as (this: NoticeContext, message: AssistantMessage) => void;

describe("InteractiveMode assistant diagnostics", () => {
	test("shows Anthropic thinking drops", () => {
		initTheme("dark");
		const context = {
			chatContainer: new Container(),
			sessionManager: { getBranch: () => [] },
		};
		maybeShowThinkingDropNotice.call(context, message);
		const output = stripAnsi(context.chatContainer.render(120).join("\n"));
		expect(output).toContain("Anthropic dropped 3 thinking blocks (details in session)");
	});

	test("does not repeat unchanged Anthropic thinking drops", () => {
		initTheme("dark");
		const context = {
			chatContainer: new Container(),
			sessionManager: { getBranch: () => [{ type: "message" as const, message }] },
		};

		maybeShowThinkingDropNotice.call(context, { ...message, timestamp: 2 });

		expect(context.chatContainer.children).toHaveLength(0);
	});
});
