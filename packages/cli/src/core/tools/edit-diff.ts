import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

const defaultContextLines = 4;

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

export interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

// Line endings
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreCrlf(text: string): string {
	return text.replace(/\n/g, "\r\n");
}

export function isUniformCrlf(content: string): boolean {
	return content.includes("\r\n") && !/\r(?!\n)|(?<!\r)\n/.test(content);
}

// Folding
function foldForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export function normalizeForFuzzyMatch(text: string): string {
	return foldForFuzzyMatch(text)
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);

	return countOverlapping(fuzzyContent, fuzzyOldText);
}

function countOverlapping(content: string, oldText: string): number {
	if (!oldText) return 0;

	let count = 0;
	let index = content.indexOf(oldText);

	while (index !== -1) {
		count += 1;
		index = content.indexOf(oldText, index + 1);
	}

	return count;
}

// Error messages
function reasonForCode(code: unknown): string | undefined {
	if (code === "ENOENT") return "File missing";
	if (code === "EACCES" || code === "EPERM") return "Access denied";
	if (code === "EISDIR") return "Is directory";
	return undefined;
}

// Search
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);

	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

// Replacements
function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;

	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		const tail = result.substring(matchIndex + replacement.matchLength);

		result = result.substring(0, matchIndex) + replacement.newText + tail;
	}

	return result;
}

// Patches
export function generateUnifiedPatch(
	path: string,
	oldContent: string,
	newContent: string,
	contextLines = defaultContextLines,
): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

interface ClusterMap {
	chars: string[];
	starts: number[];
	ends: number[];
}

// Cluster map
function buildClusterMap(original: string): ClusterMap {
	const chars: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	let lineStart = 0;

	const trimLine = () => {
		while (chars.length > lineStart && /\s/.test(chars[chars.length - 1])) {
			chars.pop();
			starts.pop();
			ends.pop();
		}
	};

	for (const match of original.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
		const index = match.index ?? 0;

		if (match[0] === "\n") trimLine();

		for (const unit of foldForFuzzyMatch(match[0]).split("")) {
			chars.push(unit);
			starts.push(index);
			ends.push(index + match[0].length);
		}

		if (match[0] === "\n") lineStart = chars.length;
	}

	trimLine();
	return { chars, starts, ends };
}

// Fuzzy spans
function mapSpansToOriginal(
	original: string,
	fuzzy: string,
	spans: TextReplacement[],
): TextReplacement[] {
	const { chars, starts, ends } = buildClusterMap(original);

	if (chars.join("") !== fuzzy) {
		throw new Error("No match");
	}

	const cutsCluster = (at: number) => at > 0 && at < fuzzy.length && starts[at] === starts[at - 1];

	return spans.map((span) => {
		const first = span.matchIndex;
		const last = first + span.matchLength;

		if (cutsCluster(first) || cutsCluster(last)) {
			throw new Error("Exact text needed");
		}

		const matchIndex = first < fuzzy.length ? starts[first] : original.length;
		const matchEnd = last > first ? ends[last - 1] : matchIndex;

		return { matchIndex, matchLength: matchEnd - matchIndex, newText: span.newText };
	});
}

// Match edits
function matchAllEdits(
	edits: Edit[],
	baseContent: string,
): { matchedEdits: MatchedEdit[]; usedFuzzyMatch: boolean } {
	const initialMatches = edits.map((edit) => fuzzyFindText(baseContent, edit.oldText));

	// CR folding
	const usedFuzzyMatch =
		baseContent.includes("\r") || initialMatches.some((match) => match.usedFuzzyMatch);
	const searchContent = usedFuzzyMatch ? normalizeForFuzzyMatch(baseContent) : baseContent;

	const matchedEdits: MatchedEdit[] = [];

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		const matchResult = fuzzyFindText(searchContent, edit.oldText);

		if (!matchResult.found) {
			throw new Error("Text missing");
		}

		const occurrences = matchResult.usedFuzzyMatch
			? countOccurrences(searchContent, edit.oldText)
			: countOverlapping(searchContent, edit.oldText);

		if (occurrences > 1) {
			throw new Error("Duplicate text");
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);

	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];

		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error("Edits overlap");
		}
	}

	return { matchedEdits, usedFuzzyMatch };
}

// Apply edits
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw new Error("Empty old text");
		}
	}

	const { matchedEdits, usedFuzzyMatch } = matchAllEdits(normalizedEdits, normalizedContent);

	const baseContent = normalizedContent;
	const replacements = usedFuzzyMatch
		? mapSpansToOriginal(baseContent, normalizeForFuzzyMatch(baseContent), matchedEdits)
		: matchedEdits;
	const newContent = applyReplacements(baseContent, replacements);

	if (baseContent === newContent) {
		throw new Error("No change");
	}

	return { baseContent, newContent };
}

export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;

			return { error: reasonForCode(code) ?? "Edit failed" };
		}

		const rawContent = await readFile(absolutePath, "utf-8");
		const { text: content } = splitBom(rawContent);
		const normalized = isUniformCrlf(content) ? normalizeToLF(content) : content;
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalized, edits);

		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// Visual diff
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = defaultContextLines,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;
	const blankGutter = "".padStart(lineNumWidth, " ");
	const pad = (lineNum: number) => String(lineNum).padStart(lineNumWidth, " ");

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");

		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			for (const line of raw) {
				if (part.added) {
					output.push(`+${pad(newLineNum)} ${line}`);
					newLineNum++;
				} else {
					output.push(`-${pad(oldLineNum)} ${line}`);
					oldLineNum++;
				}
			}

			lastWasChange = true;
			continue;
		}

		const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
		const hasLeadingChange = lastWasChange;
		const hasTrailingChange = nextPartIsChange;

		if (hasLeadingChange && hasTrailingChange) {
			if (raw.length <= contextLines * 2) {
				for (const line of raw) {
					output.push(` ${pad(oldLineNum)} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				const leadingLines = raw.slice(0, contextLines);
				const trailingLines = raw.slice(raw.length - contextLines);
				const skippedLines = raw.length - leadingLines.length - trailingLines.length;

				for (const line of leadingLines) {
					output.push(` ${pad(oldLineNum)} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				output.push(` ${blankGutter} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;

				for (const line of trailingLines) {
					output.push(` ${pad(oldLineNum)} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			}
		} else if (hasLeadingChange) {
			const shownLines = raw.slice(0, contextLines);
			const skippedLines = raw.length - shownLines.length;

			for (const line of shownLines) {
				output.push(` ${pad(oldLineNum)} ${line}`);
				oldLineNum++;
				newLineNum++;
			}

			if (skippedLines > 0) {
				output.push(` ${blankGutter} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}
		} else if (hasTrailingChange) {
			const skippedLines = Math.max(0, raw.length - contextLines);

			if (skippedLines > 0) {
				output.push(` ${blankGutter} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}

			for (const line of raw.slice(skippedLines)) {
				output.push(` ${pad(oldLineNum)} ${line}`);
				oldLineNum++;
				newLineNum++;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}

		lastWasChange = false;
	}

	return { diff: output.join("\n"), firstChangedLine };
}
