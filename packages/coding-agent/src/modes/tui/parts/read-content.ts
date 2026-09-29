import { truncateToWidth } from "@huranth/gama-tui";
import { getTextOutput, replaceTabs } from "../../../core/tools/render-utils.ts";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";
import type { ActivityRecord } from "./activity.ts";
import { renderDiff } from "./diff.ts";

export interface CardBodyArgs {
	path?: string;
	file_path?: string;
	content?: string;
	edits?: unknown;
	newText?: unknown;
}

export function clipToWidth(value: string, width: number, ellipsis = ""): string {
	return truncateToWidth(value, Math.max(0, width), ellipsis);
}

export function renderCardBodyRows(record: ActivityRecord): string[] {
	return (
		editDiffRows(record) ??
		editStreamingRows(record) ??
		writeContentRows(record) ??
		resultTextRows(record)
	);
}

function editDiffRows(record: ActivityRecord): string[] | undefined {
	if (record.name !== "edit") return undefined;

	const details = record.result?.details as { diff?: unknown } | undefined;
	const diff = details?.diff;
	if (typeof diff !== "string" || !diff.trim()) return undefined;

	const lines = renderDiff(diff).split("\n");

	return trimTrailingEmptyLines(lines);
}

function editStreamingRows(record: ActivityRecord): string[] | undefined {
	if (record.name !== "edit") return undefined;
	if (record.status !== "pending" && record.status !== "running") return undefined;

	const args = cardArgs(record);
	const parts = pendingTextParts(args);
	if (parts.length === 0) return undefined;

	const lines = toLines(parts.join("\n"));
	if (lines.length === 0) return undefined;

	const path = args.path ?? args.file_path;

	return colorCodeRows(path, lines);
}

function writeContentRows(record: ActivityRecord): string[] | undefined {
	if (record.name !== "write" || record.status === "error") return undefined;

	const args = cardArgs(record);
	if (typeof args.content !== "string" || !args.content) return undefined;

	const lines = toLines(args.content);
	if (lines.length === 0) return undefined;

	const path = args.path ?? args.file_path;

	return colorCodeRows(path, lines);
}

function resultTextRows(record: ActivityRecord): string[] {
	const output = getTextOutput(record.result, true);
	if (!output.trim()) return [];

	const lines = toLines(output);
	if (lines.length === 0) return [];

	const args = cardArgs(record);
	const path = args.path ?? args.file_path;
	const isFileRead = record.name === "read" || record.name === "write";
	const lang = isFileRead && path ? getLanguageFromPath(path) : undefined;
	const color = record.status === "error" ? "error" : "toolOutput";
	if (!lang) {
		return lines.map((line) =>
			isNoteLine(line) ? theme.fg("muted", line) : theme.fg(color, line),
		);
	}

	const highlighted = highlightCode(lines.join("\n"), lang);

	return lines.map((raw, index) => {
		if (isNoteLine(raw)) return theme.fg("muted", raw);
		if (record.status === "error") return theme.fg("error", raw);

		return highlighted[index] ?? theme.fg(color, raw);
	});
}

function pendingTextParts(args: CardBodyArgs): string[] {
	const parts: string[] = [];
	if (Array.isArray(args.edits)) {
		for (const entry of args.edits) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

			const next = (entry as Record<string, unknown>).newText;
			if (typeof next === "string" && next) parts.push(next);
		}
	}

	if (parts.length === 0 && typeof args.newText === "string" && args.newText) {
		parts.push(args.newText);
	}

	return parts;
}

function colorCodeRows(path: string | undefined, lines: string[]): string[] {
	const lang = path ? getLanguageFromPath(path) : undefined;
	if (!lang) return lines.map((line) => theme.fg("toolOutput", line));

	return highlightCode(lines.join("\n"), lang);
}

function toLines(text: string): string[] {
	return trimTrailingEmptyLines(replaceTabs(text).split("\n"));
}

function cardArgs(record: ActivityRecord): CardBodyArgs {
	const args = record.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};

	return args as CardBodyArgs;
}

function isNoteLine(line: string): boolean {
	const trimmed = line.trim();

	return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}

	return lines.slice(0, end);
}
