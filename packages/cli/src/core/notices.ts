const MAX_NOTICE_WORDS = 8;

const MAX_SENTENCE_WORDS = 10;

const MAX_SENTENCE_CHARS = 80;

// Provider wording
const PROVIDER_DETAIL_PATTERNS: Array<[RegExp, string]> = [
	[/unsupported:?\s*reasoning(_content|_text)?/i, "Reasoning not supported"],
	[/unsupported:?\s*temperature/i, "Temperature not supported"],
	[/unsupported:?\s*([a-z_]+)/i, "Option not supported"],
	[/model (?:not found|does not exist)/i, "Model not found"],
	[/context (?:length|window) exceeded/i, "Context limit reached"],
	[/invalid (?:api )?key/i, "Invalid API key"],
	[/unauthori[sz]ed|\b(?:401|403)\b/i, "Authentication failed"],
	[/rate limit|\b429\b/i, "Rate limit reached"],
];

// No clamp
const ACTIONABLE_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|global)\b|\bRun:\s*\S/i;

function clampWords(text: string, maxWords: number): string {
	const words = text.split(/\s+/).filter((word) => word.length > 0);

	if (words.length <= maxWords) return words.join(" ");
	return `${words.slice(0, maxWords).join(" ")}...`;
}

function firstSentence(text: string): string | undefined {
	const pattern = new RegExp(`^(.{1,${MAX_SENTENCE_CHARS}}?[.!?])(?:\\s|$)`);
	const match = pattern.exec(text);

	return match?.[1];
}

function readJsonMessage(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start === -1) return undefined;

	try {
		const parsed = JSON.parse(text.slice(start));
		if (typeof parsed !== "object" || parsed === null) return undefined;

		const record = parsed as Record<string, unknown>;
		if (typeof record.message === "string" && record.message.trim() !== "") return record.message;
		if (typeof record.error === "string" && record.error.trim() !== "") return record.error;

		const error = record.error;
		if (typeof error === "object" && error !== null) {
			const nested = (error as Record<string, unknown>).message;
			if (typeof nested === "string" && nested.trim() !== "") return nested;
		}
	} catch {
		// Not JSON
	}

	return undefined;
}

function cleanNoticeText(text: string): string {
	const firstLine = text.split("\n")[0] ?? "";

	return firstLine
		.replace(/https?:\/\/\S+/gi, "")
		.replace(/[A-Za-z]:\\[^\s,;)]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[:\-–—\s]+/, "");
}

export function formatNotice(message: string): string {
	let text = message.trim();
	if (!text) return "Unknown error";

	const jsonMessage = readJsonMessage(text);
	if (jsonMessage !== undefined) text = jsonMessage;

	for (const [pattern, replacement] of PROVIDER_DETAIL_PATTERNS) {
		if (pattern.test(text)) {
			text = replacement;
			break;
		}
	}

	text = cleanNoticeText(text);
	if (!text) return "Unknown error";

	const first = text[0] ?? "";
	if (first === first.toLowerCase()) {
		text = first.toUpperCase() + text.slice(1);
	}

	if (ACTIONABLE_COMMAND.test(text)) return text;

	const sentence = firstSentence(text);
	const sentenceWords = sentence?.split(/\s+/).length ?? 0;
	if (sentence && sentenceWords <= MAX_SENTENCE_WORDS) text = sentence;

	text = text.replace(/[.,;:\s]+$/, "");

	return clampWords(text, MAX_NOTICE_WORDS);
}
