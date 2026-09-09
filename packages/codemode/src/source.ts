export interface CodemodeSourceOptions {
	maxOutputTokens?: number;
	timeoutMs?: number;
}

export interface ParsedCodemodeSource {
	code: string;
	options: CodemodeSourceOptions;
}

export const CODEMODE_OPTIONS_PREFIX = "// @options:";

const SUPPORTED_FIELDS = ["max_output_tokens", "timeout_ms"] as const;

const SUPPORTED_FIELDS_TEXT = "`max_output_tokens` and `timeout_ms`";

const MAX_TIMEOUT_MS = 2_147_483_647;

export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*\/\/ @options:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export class CodemodeSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeSourceError";
	}
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	if (input.trim() === "") {
		throw new CodemodeSourceError(
			"Expected JavaScript source text (non-empty). Provide JS only, optionally " +
				'with a first line `// @options: {"max_output_tokens": 1000}`.',
		);
	}
	const newline = input.indexOf("\n");
	const firstLine = (newline === -1 ? input : input.slice(0, newline)).replace(/\r$/, "");
	const trimmed = firstLine.trimStart();
	if (!trimmed.startsWith(CODEMODE_OPTIONS_PREFIX)) return { code: input, options: {} };
	const code = newline === -1 ? "" : input.slice(newline);
	if (code.trim() === "") {
		throw new CodemodeSourceError(
			"The @options line must be followed by JavaScript source on subsequent lines",
		);
	}
	return { code, options: parseOptions(trimmed.slice(CODEMODE_OPTIONS_PREFIX.length).trim()) };
}

function parseOptions(directive: string): CodemodeSourceOptions {
	if (directive === "") {
		throw new CodemodeSourceError(
			`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(directive);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new CodemodeSourceError(
			`@options must be valid JSON with supported fields ${SUPPORTED_FIELDS_TEXT}: ${reason}`,
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodemodeSourceError(
			`@options must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`,
		);
	}
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields)) {
		if (!(SUPPORTED_FIELDS as readonly string[]).includes(key)) {
			throw new CodemodeSourceError(
				`@options only supports ${SUPPORTED_FIELDS_TEXT}; got \`${key}\``,
			);
		}
	}
	const options: CodemodeSourceOptions = {};
	const { max_output_tokens, timeout_ms } = fields;
	if (max_output_tokens !== undefined) {
		if (!isSafeInteger(max_output_tokens)) {
			throw new CodemodeSourceError(
				"@options field `max_output_tokens` must be a non-negative safe integer",
			);
		}
		options.maxOutputTokens = max_output_tokens;
	}
	if (timeout_ms !== undefined) {
		if (!isSafeInteger(timeout_ms) || timeout_ms === 0 || timeout_ms > MAX_TIMEOUT_MS) {
			throw new CodemodeSourceError(
				`@options field \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`,
			);
		}
		options.timeoutMs = timeout_ms;
	}
	return options;
}
