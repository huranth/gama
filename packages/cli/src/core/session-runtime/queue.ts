import type { Runner } from "@huranth/gama-agent-core";
import type { ImageContent, TextContent } from "@huranth/gama-ai/compat";
import type { InputSource } from "../ext/index.ts";
import { expandPromptTemplate, type PromptTemplate } from "../prompt-templates.ts";

export type QueuedInputDisposition = "handled" | "queued";

export interface QueueTarget {
	steering: string[];
	followUp: string[];
	agent: Pick<Runner, "steer" | "followUp">;
	emitUpdate(): void;
}

export function consumeQueuedText(queue: readonly string[], text: string): number {
	const target = text.trim();
	if (!target) return 0;

	let joined = "";
	for (let index = 0; index < queue.length; index++) {
		joined += (index > 0 ? "\n\n" : "") + queue[index].trim();
		if (joined === target) return index + 1;
		if (!target.startsWith(joined)) return 0;
	}

	return 0;
}

export function consumeQueuedMessage(queue: string[], text: string): number {
	const removed = consumeQueuedText(queue, text);
	if (removed > 0) {
		queue.splice(0, removed);
		return removed;
	}

	if (queue.length === 0) return 0;

	const index = text ? queue.indexOf(text) : queue.findIndex((queued) => queued.trim() === "");
	if (index === -1) return 0;

	queue.splice(index, 1);
	return 1;
}

export function makeUserContent(
	text: string,
	images: ImageContent[] | undefined,
): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images) {
		content.push(...images);
	}
	return content;
}

export function queueSteeringInput(
	target: QueueTarget,
	text: string,
	images?: ImageContent[],
): void {
	target.steering.push(text);
	target.emitUpdate();
	target.agent.steer({
		role: "user",
		content: makeUserContent(text, images),
		timestamp: Date.now(),
		steering: true,
	});
}

export function queueFollowUpInput(
	target: QueueTarget,
	text: string,
	images?: ImageContent[],
): void {
	target.followUp.push(text);
	target.emitUpdate();
	target.agent.followUp({
		role: "user",
		content: makeUserContent(text, images),
		steering: false,
		timestamp: Date.now(),
	});
}

export function countPendingMessages(input: {
	steering: readonly unknown[];
	followUp: readonly unknown[];
	pendingNextTurn: readonly unknown[];
	pendingCustom: readonly unknown[];
}): number {
	return (
		input.steering.length +
		input.followUp.length +
		input.pendingNextTurn.length +
		input.pendingCustom.length
	);
}

export interface QueueUserInputContext extends QueueTarget {
	isStreaming: boolean;
	throwIfExtensionCommand(text: string): void;
	runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		behavior: "steer" | "followUp" | undefined,
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined>;
	expandSkillCommand(text: string): string;
	getPromptTemplates(): readonly PromptTemplate[];
}

export async function queueUserInput(
	context: QueueUserInputContext,
	text: string,
	images: ImageContent[] | undefined,
	behavior: "steer" | "followUp",
	source: InputSource,
): Promise<QueuedInputDisposition> {
	if (text.startsWith("/")) {
		context.throwIfExtensionCommand(text);
	}

	const processedInput = await context.runInputHandlers(
		text,
		images,
		source,
		context.isStreaming ? behavior : undefined,
	);
	if (!processedInput) return "handled";

	let expandedText = context.expandSkillCommand(processedInput.text);
	expandedText = expandPromptTemplate(expandedText, [...context.getPromptTemplates()]);

	if (behavior === "steer") {
		queueSteeringInput(context, expandedText, processedInput.images);
	} else {
		queueFollowUpInput(context, expandedText, processedInput.images);
	}
	return "queued";
}
