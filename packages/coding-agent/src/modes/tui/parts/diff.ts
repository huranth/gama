import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

export interface RenderDiffOptions {
	filePath?: string;
}

type DiffLine = { lineNum: string; content: string };

function isDiffHeader(line: string): boolean {
	return line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@");
}

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;

	return { prefix: match[1]!, lineNum: match[2]!, content: match[3]! };
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function takeDiffLines(lines: string[], start: number, prefix: string): [DiffLine[], number] {
	const collected: DiffLine[] = [];
	let index = start;

	while (index < lines.length) {
		const parsed = parseDiffLine(lines[index]!);
		if (!parsed || parsed.prefix !== prefix) break;

		collected.push({ lineNum: parsed.lineNum, content: parsed.content });
		index++;
	}

	return [collected, index];
}

function renderChangedBlock(removedLines: DiffLine[], addedLines: DiffLine[]): string[] {
	if (removedLines.length === 1 && addedLines.length === 1) {
		const removed = removedLines[0]!;
		const added = addedLines[0]!;
		const intra = renderIntraLineDiff(replaceTabs(removed.content), replaceTabs(added.content));

		return [
			theme.fg("toolDiffRemoved", `-${removed.lineNum} ${intra.removedLine}`),
			theme.fg("toolDiffAdded", `+${added.lineNum} ${intra.addedLine}`),
		];
	}

	const output: string[] = [];

	for (const removed of removedLines) {
		const text = `-${removed.lineNum} ${replaceTabs(removed.content)}`;

		output.push(theme.fg("toolDiffRemoved", text));
	}

	for (const added of addedLines) {
		const text = `+${added.lineNum} ${replaceTabs(added.content)}`;

		output.push(theme.fg("toolDiffAdded", text));
	}

	return output;
}

function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			const next = appendChanged(removedLine, part.value, isFirstRemoved);

			removedLine = next.line;
			isFirstRemoved = next.isFirst;
			continue;
		}

		if (part.added) {
			const next = appendChanged(addedLine, part.value, isFirstAdded);

			addedLine = next.line;
			isFirstAdded = next.isFirst;
			continue;
		}

		removedLine += part.value;
		addedLine += part.value;
	}

	return { removedLine, addedLine };
}

function appendChanged(
	line: string,
	value: string,
	isFirst: boolean,
): { line: string; isFirst: boolean } {
	if (!isFirst) {
		const highlighted = value ? theme.inverse(value) : "";

		return { line: line + highlighted, isFirst };
	}

	const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
	const rest = value.slice(leadingWhitespace.length);
	const highlighted = rest ? theme.inverse(rest) : "";

	return { line: line + leadingWhitespace + highlighted, isFirst: false };
}

export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index]!;

		if (isDiffHeader(line)) {
			index++;
			continue;
		}

		const parsed = parseDiffLine(line);
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			index++;
			continue;
		}

		if (parsed.prefix === "-") {
			const [removedLines, afterRemoved] = takeDiffLines(lines, index, "-");
			const [addedLines, next] = takeDiffLines(lines, afterRemoved, "+");

			result.push(...renderChangedBlock(removedLines, addedLines));
			index = next;
			continue;
		}

		if (parsed.prefix === "+") {
			const text = `+${parsed.lineNum} ${replaceTabs(parsed.content)}`;

			result.push(theme.fg("toolDiffAdded", text));
			index++;
			continue;
		}

		const text = ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`;

		result.push(theme.fg("toolDiffContext", text));
		index++;
	}

	return result.join("\n");
}
