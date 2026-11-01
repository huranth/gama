import type { AutocompleteItem } from "../autocomplete.ts";
import type { SelectListLayoutOptions } from "../view/select-list.ts";
import {
	autocompleteBoundaryRegex,
	autocompleteSeparatorRegex,
	isWhitespaceChar,
} from "../utils.ts";

export const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

export const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;

export const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];

const unquotedAutocompleteSuffixRegex = new RegExp(
	`(?:(?!${autocompleteSeparatorRegex.source}).)*`,
	"u",
);

const autocompleteTokenStartSource = `${autocompleteBoundaryRegex.source}[([{<\`]*`;

export function buildTriggerCharacters(triggerCharacters: string[]): string[] {
	const next = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
	for (const character of triggerCharacters) {
		if (
			character.length !== 1 ||
			character === "/" ||
			isWhitespaceChar(character) ||
			next.includes(character)
		) {
			continue;
		}
		next.push(character);
	}
	return next;
}

export function buildTriggerPattern(triggerCharacters: string[]): RegExp {
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@"[^"]*|[` +
			`${triggerCharacters.map(escapeCharacterClass).join("")}]` +
			`${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

export function buildDebouncePattern(triggerCharacters: string[]): RegExp {
	const escapedWithoutAt = triggerCharacters
		.filter((character) => character !== "@")
		.map(escapeCharacterClass);
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@(?:"[^"]*|` +
			`${unquotedAutocompleteSuffixRegex.source})|[${escapedWithoutAt.join("")}]` +
			`${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

export function findBestMatchIndex(items: AutocompleteItem[], prefix: string): number {
	if (!prefix) return -1;

	let firstPrefixIndex = -1;

	for (let i = 0; i < items.length; i++) {
		const value = items[i]!.value;
		if (value === prefix) {
			return i;
		}
		if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
			firstPrefixIndex = i;
		}
	}

	return firstPrefixIndex;
}

export function resolveDebounceMs(
	pattern: RegExp,
	options: { force: boolean; explicitTab: boolean },
	textBeforeCursor: string,
): number {
	if (options.explicitTab || options.force) {
		return 0;
	}

	return pattern.test(textBeforeCursor) ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
}

function escapeCharacterClass(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}
