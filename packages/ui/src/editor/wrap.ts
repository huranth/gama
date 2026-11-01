import {
	cjkBreakRegex,
	getGraphemeSegmenter,
	getWordSegmenter,
	isWhitespaceChar,
	visibleWidth,
} from "../utils.ts";

const graphemeSegmenter = getGraphemeSegmenter();

const wordSegmenter = getWordSegmenter();

export const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

export const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

export function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

export function segmentText(
	text: string,
	mode: "word" | "grapheme",
	validIds: Set<number>,
): Iterable<Intl.SegmentData> {
	const baseSegmenter = mode === "word" ? wordSegmenter : graphemeSegmenter;
	return segmentWithMarkers(text, baseSegmenter, validIds);
}

function segmentWithMarkers(
	text: string,
	baseSegmenter: Intl.Segmenter,
	validIds: Set<number>,
): Iterable<Intl.SegmentData> {
	if (validIds.size === 0 || !text.includes("[paste #")) {
		return baseSegmenter.segment(text);
	}

	const markers: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(m[1]!, 10);
		if (!validIds.has(id)) continue;
		markers.push({ start: m.index, end: m.index + m[0].length });
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}

	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
		} else {
			result.push(seg);
		}
	}

	return result;
}

export function wordWrapLine(
	line: string,
	maxWidth: number,
	preSegmented?: Intl.SegmentData[],
): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...graphemeSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				chunks.push({
					text: line.slice(chunkStart, wrapOppIndex),
					startIndex: chunkStart,
					endIndex: wrapOppIndex,
				});
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				chunks.push({
					text: line.slice(chunkStart, charIndex),
					startIndex: chunkStart,
					endIndex: charIndex,
				});
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			if (isPasteMarker(grapheme)) {
				const subChunks = wordWrapLine(grapheme, maxWidth);
				for (let j = 0; j < subChunks.length - 1; j++) {
					const sc = subChunks[j]!;
					chunks.push({
						text: sc.text,
						startIndex: charIndex + sc.startIndex,
						endIndex: charIndex + sc.endIndex,
					});
				}
				const last = subChunks[subChunks.length - 1]!;
				chunkStart = charIndex + last.startIndex;
				currentWidth = visibleWidth(last.text);
			} else {
				chunks.push({
					text: grapheme,
					startIndex: charIndex,
					endIndex: charIndex + grapheme.length,
				});
				chunkStart = charIndex + grapheme.length;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
			continue;
		}

		currentWidth += gWidth;

		const next = segments[i + 1];
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		} else if (!isWs && next && !isWhitespaceChar(next.segment)) {
			const isCjk = !isPasteMarker(grapheme) && cjkBreakRegex.test(grapheme);
			const nextIsCjk = !isPasteMarker(next.segment) && cjkBreakRegex.test(next.segment);
			if (isCjk || nextIsCjk) {
				wrapOppIndex = next.index;
				wrapOppWidth = currentWidth;
			}
		}
	}

	if (chunkStart < line.length) {
		chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
	}

	return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
}
