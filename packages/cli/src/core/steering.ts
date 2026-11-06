import type { ImageContent, TextContent } from "@huranth/gama-ai";

type UserContent = TextContent | ImageContent;

const STEERING_TAG = "user_message_sent_while_working";

const STEERING_OPEN = `<${STEERING_TAG}>`;

const STEERING_CLOSE = `</${STEERING_TAG}>`;

export const STEERING_NOTE =
	"The user sent this while you were working. Continue the earlier request too, " +
	"unless this message changes or cancels it.";

export function frameSteeringText(text: string): string {
	if (text.startsWith(STEERING_OPEN)) return text;

	return `${STEERING_OPEN}\n${text}\n${STEERING_CLOSE}\n\n${STEERING_NOTE}`;
}

export function unwrapSteeringText(text: string): string {
	if (!text.startsWith(STEERING_OPEN)) return text;

	const end = text.lastIndexOf(STEERING_CLOSE);
	if (end === -1) return text;

	const body = text.slice(STEERING_OPEN.length, end);

	return body.replace(/^\n|\n$/g, "");
}

export function frameSteeringContent(content: readonly UserContent[]): UserContent[] {
	const index = content.findIndex((part) => part.type === "text");

	if (index === -1) {
		return [{ type: "text", text: frameSteeringText("") }, ...content];
	}

	return content.map((part, i) => {
		if (i !== index || part.type !== "text") return part;

		return { ...part, text: frameSteeringText(part.text) };
	});
}
