import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

export interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

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

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreCrlf(text: string): string {
	return text.replace(/\n/g, "\r\n");
}

// NFKC plus quote, dash and space folding. Works per character, so it can be applied to
// one cluster at a time when mapping fuzzy offsets back to the original text.
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

/**
 * Translate spans found in the fuzzy-normalised text back to spans of the original text, so a
 * fuzzy edit only replaces what it matched and leaves the rest of the line as written.
 */
function mapSpansToOriginal(
	original: string,
	fuzzy: string,
	spans: TextReplacement[],
): TextReplacement[] {
	// One entry per UTF-16 unit of the fuzzy text: the original cluster it came from.
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
	if (chars.join("") !== fuzzy) {
		throw new Error(
			"Could not map the match back to the original text, add more context so it matches exactly",
		);
	}

	const cutsCluster = (at: number) => at > 0 && at < fuzzy.length && starts[at] === starts[at - 1];
	return spans.map((span) => {
		const first = span.matchIndex;
		const last = first + span.matchLength;
		if (cutsCluster(first) || cutsCluster(last)) {
			throw new Error(
				"The old text only matches after Unicode normalization and cuts through a character " +
					"that normalization expands, use the exact characters from the file",
			);
		}
		const matchIndex = first < fuzzy.length ? starts[first] : original.length;
		const matchEnd = last > first ? ends[last - 1] : matchIndex;
		return { matchIndex, matchLength: matchEnd - matchIndex, newText: span.newText };
	});
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

export function generateUnifiedPatch(
	path: string,
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) +
			replacement.newText +
			result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find that text in ${path}, the old text must match exactly ` +
				"including whitespace and newlines",
		);
	}
	return new Error(
		`Could not find change ${editIndex + 1} in ${path}, its old text must match ` +
			"exactly including whitespace and newlines",
	);
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} copies of that text in ${path}, add more context to make it unique`,
		);
	}
	return new Error(
		`Found ${occurrences} copies of change ${editIndex + 1} in ${path}, add more ` +
			"context to make it unique",
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`The old text is empty in ${path}, include the text to replace`);
	}
	return new Error(`Change ${editIndex + 1} has an empty old text in ${path}`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`The edit made no change to ${path}, the new text is identical to the old text`,
		);
	}
	return new Error(
		`The edits made no change to ${path}, the new text is identical to the old text`,
	);
}

// Only a file whose every line break is CRLF is safe to fold to LF and restore on write.
export function isUniformCrlf(content: string): boolean {
	return content.includes("\r\n") && !/\r(?!\n)|(?<!\r)\n/.test(content);
}

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
			const reason =
				code === "ENOENT"
					? "the file does not exist"
					: code === "EACCES" || code === "EPERM"
						? "permission denied"
						: code === "EISDIR"
							? "it is a directory"
							: error instanceof Error
								? error.message
								: String(error);
			return { error: `Could not edit ${path}, ${reason}` };
		}

		const rawContent = await readFile(absolutePath, "utf-8");

		const { text: content } = splitBom(rawContent);
		const normalizedContent = isUniformCrlf(content) ? normalizeToLF(content) : content;
		const { baseContent, newContent } = applyEditsToNormalizedContent(
			normalizedContent,
			edits,
			path,
		);

		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) =>
		fuzzyFindText(normalizedContent, edit.oldText),
	);
	// A leftover CR means mixed or lone-CR endings. Folding them away is what lets an LF
	// oldText match a CRLF line, and the span mapping keeps every unmatched byte as it was.
	const usedFuzzyMatch =
		normalizedContent.includes("\r") || initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = matchResult.usedFuzzyMatch
			? countOccurrences(replacementBaseContent, edit.oldText)
			: replacementBaseContent.split(edit.oldText).length - 1;
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
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
			throw new Error(
				`Change ${previous.editIndex + 1} and change ${current.editIndex + 1} overlap ` +
					`in ${path}, merge them into one edit or target separate regions`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = applyReplacements(
		baseContent,
		usedFuzzyMatch
			? mapSpansToOriginal(baseContent, replacementBaseContent, matchedEdits)
			: matchedEdits,
	);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

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
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange =
				i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}
