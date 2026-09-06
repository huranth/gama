import { getWordSegmenter, isWhitespaceChar, PUNCTUATION_REGEX } from "./utils.ts";

export interface WordNavigationOptions {
	segment?: (text: string) => Iterable<Intl.SegmentData>;
	isAtomicSegment?: (segment: string) => boolean;
}

const wordSegmenter = getWordSegmenter();

function splitSegments(text: string, options?: WordNavigationOptions): Intl.SegmentData[] {
	if (options?.segment) {
		return [...options.segment(text)];
	}
	return [...wordSegmenter.segment(text)];
}

function lastSegment(segments: Intl.SegmentData[]): Intl.SegmentData {
	return segments[segments.length - 1]!;
}

export function findWordBackward(
	text: string,
	cursor: number,
	options?: WordNavigationOptions,
): number {
	if (cursor <= 0) return 0;

	const segments = splitSegments(text.slice(0, cursor), options);
	const isAtomic = options?.isAtomicSegment;
	let newCursor = cursor;

	while (segments.length > 0) {
		const segment = lastSegment(segments);
		if (isAtomic?.(segment.segment) || !isWhitespaceChar(segment.segment)) break;
		newCursor -= segment.segment.length;
		segments.pop();
	}

	if (segments.length === 0) return newCursor;

	const segment = lastSegment(segments);
	if (isAtomic?.(segment.segment)) {
		return newCursor - segment.segment.length;
	}

	if (segment.isWordLike) {
		const matches = [...segment.segment.matchAll(new RegExp(PUNCTUATION_REGEX, "g"))];
		if (matches.length === 0) {
			return newCursor - segment.segment.length;
		}
		const lastMatch = matches[matches.length - 1]!;
		const tailLength = lastMatch.index + lastMatch[0].length;
		return newCursor - (segment.segment.length - tailLength);
	}

	while (segments.length > 0) {
		const next = lastSegment(segments);
		if (isAtomic?.(next.segment)) break;
		if (next.isWordLike) break;
		if (isWhitespaceChar(next.segment)) break;
		newCursor -= next.segment.length;
		segments.pop();
	}

	return newCursor;
}

export function findWordForward(
	text: string,
	cursor: number,
	options?: WordNavigationOptions,
): number {
	if (cursor >= text.length) return text.length;

	const segments = splitSegments(text.slice(cursor), options);
	const isAtomic = options?.isAtomicSegment;
	let index = 0;
	let newCursor = cursor;

	while (index < segments.length) {
		const segment = segments[index]!;
		if (isAtomic?.(segment.segment) || !isWhitespaceChar(segment.segment)) break;
		newCursor += segment.segment.length;
		index += 1;
	}

	if (index >= segments.length) return newCursor;

	const segment = segments[index]!;
	if (isAtomic?.(segment.segment)) {
		return newCursor + segment.segment.length;
	}

	if (segment.isWordLike) {
		const punctuationIndex = PUNCTUATION_REGEX.exec(segment.segment)?.index;
		return newCursor + (punctuationIndex ?? segment.segment.length);
	}

	while (index < segments.length) {
		const next = segments[index]!;
		if (isAtomic?.(next.segment)) break;
		if (next.isWordLike) break;
		if (isWhitespaceChar(next.segment)) break;
		newCursor += next.segment.length;
		index += 1;
	}

	return newCursor;
}
