const WORD_BOUNDARY_REGEX = /[\s\-_./:]/;
const CONSECUTIVE_PENALTY = 5;
const GAP_PENALTY = 2;
const BOUNDARY_BONUS = 10;
const POSITION_WEIGHT = 0.1;
const EXACT_BONUS = 100;
const SWAP_BONUS = 5;
const LETTERS_THEN_DIGITS = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/;
const DIGITS_THEN_LETTERS = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/;

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

function isWordBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	return WORD_BOUNDARY_REGEX.test(text[index - 1]!);
}

function swapLettersAndDigits(query: string): string {
	const lettersFirst = query.match(LETTERS_THEN_DIGITS);
	if (lettersFirst) {
		return `${lettersFirst.groups?.digits ?? ""}${lettersFirst.groups?.letters ?? ""}`;
	}

	const digitsFirst = query.match(DIGITS_THEN_LETTERS);
	if (digitsFirst) {
		return `${digitsFirst.groups?.letters ?? ""}${digitsFirst.groups?.digits ?? ""}`;
	}

	return "";
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const primary = scoreMatch(queryLower, textLower);
	if (primary.matches) {
		return primary;
	}

	const swapped = swapLettersAndDigits(queryLower);
	if (!swapped) {
		return primary;
	}

	const swappedMatch = scoreMatch(swapped, textLower);
	if (!swappedMatch.matches) {
		return primary;
	}

	return { matches: true, score: swappedMatch.score + SWAP_BONUS };
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/[\s/]+/)
		.filter((token) => token.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (!match.matches) {
				allMatch = false;
				break;
			}
			totalScore += match.score;
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((result) => result.item);
}

function scoreMatch(query: string, text: string): FuzzyMatch {
	if (query.length === 0) {
		return { matches: true, score: 0 };
	}

	if (query.length > text.length) {
		return { matches: false, score: 0 };
	}

	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	while (queryIndex < query.length) {
		const index = text.indexOf(query[queryIndex]!, lastMatchIndex + 1);
		if (index === -1) break;

		const isConsecutive = lastMatchIndex === index - 1;
		if (isConsecutive) {
			consecutiveMatches += 1;
			score -= consecutiveMatches * CONSECUTIVE_PENALTY;
		} else {
			consecutiveMatches = 0;
			if (lastMatchIndex >= 0) {
				score += (index - lastMatchIndex - 1) * GAP_PENALTY;
			}
		}

		if (isWordBoundary(text, index)) {
			score -= BOUNDARY_BONUS;
		}

		score += index * POSITION_WEIGHT;
		lastMatchIndex = index;
		queryIndex += 1;
	}

	if (queryIndex < query.length) {
		return { matches: false, score: 0 };
	}

	if (query === text) {
		score -= EXACT_BONUS;
	}

	return { matches: true, score };
}
