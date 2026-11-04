import type { Message } from "../types.ts";

export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}

export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some(
		(msg) =>
			(msg.role === "user" || msg.role === "toolResult") &&
			Array.isArray(msg.content) &&
			msg.content.some((content) => content.type === "image"),
	);
}

export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Initiator": inferCopilotInitiator(params.messages),
		"Openai-Intent": "conversation-edits",
	};

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return headers;
}
