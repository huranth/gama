import type { ImageContent } from "@huranth/gama-ai";
import type { Args } from "./args.ts";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const parts: string[] = [];

	// Join lines
	const append = (part: string) => {
		if (part.length === 0) return;
		const previous = parts[parts.length - 1];
		if (previous !== undefined && !/\s$/.test(previous)) parts.push("\n");
		parts.push(part);
	};

	if (stdinContent !== undefined) {
		append(stdinContent);
	}

	if (fileText) {
		append(fileText);
	}

	if (parsed.messages.length > 0) {
		append(parsed.messages[0]);
		parsed.messages.shift();
	}

	return {
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
