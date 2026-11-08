import { uuidv7 } from "@huranth/gama-ai";
import type { ExtensionAPI } from "@huranth/gama-harness";
import { convertToLlm, serializeConversation } from "@huranth/gama-harness";

export default function (gama: ExtensionAPI) {
	gama.on("session_before_compact", async (event, ctx) => {
		ctx.ui.notify("Custom compaction extension triggered", "info");

		const { preparation, branchEntries: _, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
		} = preparation;

		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No active model, using default compaction", "warning");
			return;
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Custom compaction: summarizing ${allMessages.length} messages ` +
				`(${tokensBefore.toLocaleString()} tokens) with ${model.id}...`,
			"info",
		);

		const conversationText = serializeConversation(convertToLlm(allMessages));

		const previousContext = previousSummary
			? `\n\nPrevious session summary for context:\n${previousSummary}`
			: "";

		const summaryMessages = [
			{
				role: "user" as const,
				content: [
					{
						type: "text" as const,
						text: `Write a handoff checkpoint for another agent resuming this work.${previousContext}

Use this exact format. Leave out any section that has nothing to say:

## Goal
- What the user wants

## Now
- Done: finished work
- Active: work in progress
- Next: the next concrete action

## Rules
- Constraints or preferences that still apply

## Decisions
- What was decided and why

## Open
- Unanswered questions or blockers

## Verified
- Checks run and their results

One line per item. Preserve exact paths, names, commands, and error text.

<conversation>
${conversationText}
</conversation>`,
					},
				],
				timestamp: Date.now(),
			},
		];

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ messages: summaryMessages },
				{
					maxTokens: 2000,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted)
					ctx.ui.notify("Compaction summary was empty, using default compaction", "warning");
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction failed: ${message}`, "error");
			return;
		}
	});
}
