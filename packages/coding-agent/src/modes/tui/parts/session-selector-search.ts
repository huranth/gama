import { fuzzyMatch } from "@huranth/gama-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSessionSearchText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") {
		return true;
	}

	return hasSessionName(session);
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const value = buf.trim();
		buf = "";
		if (!value) {
			return;
		}

		tokens.push({ kind, value });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	if (hadUnclosedQuote) {
		const fallback = trimmed
			.split(/\s+/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0)
			.map((t) => ({ kind: "fuzzy" as const, value: t }));
		return {
			mode: "tokens",
			tokens: fallback,
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	const text = getSessionSearchText(session);

	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = text.search(parsed.regex);
		if (idx < 0) {
			return { matches: false, score: 0 };
		}

		return { matches: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			if (normalizedText === null) {
				normalizedText = normalizeWhitespaceLower(text);
			}
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) {
				continue;
			}

			const idx = normalizedText.indexOf(phrase);
			if (idx < 0) {
				return { matches: false, score: 0 };
			}

			totalScore += idx * 0.1;
			continue;
		}

		const match = fuzzyMatch(token.value, text);
		if (!match.matches) {
			return { matches: false, score: 0 };
		}

		totalScore += match.score;
	}

	return { matches: true, score: totalScore };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all"
			? sessions
			: sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) {
		return nameFiltered;
	}

	const parsed = parseSearchQuery(query);
	if (parsed.error) {
		return [];
	}

	if (sortMode === "recent") {
		return nameFiltered.filter((session) => matchSession(session, parsed).matches);
	}

	const scored: { session: SessionInfo; score: number }[] = [];
	for (const session of nameFiltered) {
		const result = matchSession(session, parsed);
		if (!result.matches) {
			continue;
		}

		scored.push({ session, score: result.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) {
			return a.score - b.score;
		}

		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
