import { existsSync } from "node:fs";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@huranth/gama-tui";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@huranth/gama-tui";
import { diffLines } from "diff";
import { resolveToCwd } from "../../../core/tools/path-utils.ts";
import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";
import { clipToWidth, renderCardBodyRows } from "./read-content.ts";

export interface ActivityRecord {
	toolCallId: string;
	name: string;
	args: unknown;
	status: "pending" | "running" | "success" | "error";
	result?: { content: Array<{ type: string; text?: string }>; details?: unknown };
	timestamp: number;
}

export type ActivityKind = "reading" | "editing" | "running" | "working";

interface LiveCounts {
	added: number;
	removed: number;
}

interface ActivityDetails {
	created?: boolean;
	diff?: string;
}

type CardBg = "toolErrorBg" | "toolSuccessBg" | "toolPendingBg";

const INDENT = "  ";
const BODY_INDENT = "    ";
const EXPAND_MAX = 200;
const READ_FLOOR = 650;
const LIVE_ROW = 2000;
const STRIKE_DRAW_MS = 220;
const STRIKE_FRAME = 40;
const HIGHLIGHT_FRAME = 110;
const HIGHLIGHT_WIDTH = 2;
const HIGHLIGHT_HOLD = 220;

const PATH_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"glob",
	"ls",
	"webfetch",
	"websearch",
	"edit",
	"write",
]);

function cleanText(value: string): string {
	return stripAnsi(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function keepCardBg(bg: CardBg, text: string): string {
	const ansi = theme.getBgAnsi(bg);
	return text.replace(/\x1b\[0m/g, `\x1b[0m${ansi}`);
}

function isRunning(record: ActivityRecord): boolean {
	return record.status === "pending" || record.status === "running";
}

function argsOf(record: ActivityRecord): Record<string, unknown> {
	const args = record.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};
	return args as Record<string, unknown>;
}

function detailsOf(record: ActivityRecord): ActivityDetails {
	const details = record.result?.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return {};
	return details as ActivityDetails;
}

export function activityVerb(record: ActivityRecord): string {
	return verbsOf(record).done;
}

function commandOf(record: ActivityRecord): string {
	const command = argsOf(record).command;
	return typeof command === "string" ? cleanText(command).trim() : "";
}

function runningTarget(record: ActivityRecord, cwd: string, maxWidth: number): string {
	return targetText(record, cwd, true, maxWidth);
}

function resultLines(record: ActivityRecord): string[] {
	return getTextOutput(record.result, false)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

function lineCount(text: string): number {
	const trimmed = text.replace(/\s+$/, "");
	return trimmed ? trimmed.split("\n").length : 0;
}

function textLength(value: unknown): number {
	return typeof value === "string" ? value.length : 0;
}

function runningText(
	record: ActivityRecord,
	cwd: string,
	counts: LiveCounts | undefined,
	maxWidth: number,
): string {
	const target = runningTarget(record, cwd, maxWidth);
	const counter = counts ? counterText(record, counts) : "";
	return [target, counter].filter(Boolean).join("  ");
}

function shortName(value: string): string {
	const text = cleanText(value).trim();
	const first = text.split(/\s+/, 1)[0] ?? text;
	return clipToWidth(first || text, 24);
}

export function activityKind(toolName: string): ActivityKind {
	switch (toolName) {
		case "read":
		case "grep":
		case "find":
		case "glob":
		case "ls":
		case "webfetch":
		case "websearch":
			return "reading";
		case "edit":
		case "write":
			return "editing";
		case "bash":
		case "powershell":
			return "running";
		default:
			return "working";
	}
}

function writeExists(record: ActivityRecord, cwd: string): boolean {
	const path = activityTargetPath(record);
	if (!path) return false;

	try {
		return existsSync(resolveToCwd(path, cwd));
	} catch {
		return false;
	}
}

function failedVerb(record: ActivityRecord): string {
	switch (record.name) {
		case "read":
			return "failed to read";
		case "edit":
			return "failed to edit";
		case "write":
			return "failed to write";
		case "grep":
			return "failed to search";
		case "find":
		case "glob":
			return "failed to find";
		case "ls":
			return "failed to list";
		case "bash":
		case "powershell":
			return "failed to run";
		case "webfetch":
			return "failed to fetch";
		default:
			return "failed";
	}
}

export function activityTargetPath(record: ActivityRecord): string {
	const args = argsOf(record);
	const target =
		args.path ?? args.file_path ?? args.filePath ?? args.url ?? args.query ?? args.pattern;
	return typeof target === "string" ? cleanText(target) : "";
}

export function formatActivityLine(
	record: ActivityRecord,
	cwd: string,
	maxWidth = Number.POSITIVE_INFINITY,
): string {
	if (isRunning(record)) {
		if (!runningTarget(record, cwd, maxWidth)) return "";

		const detail = runningText(record, cwd, getCounts(record), maxWidth);
		const head = theme.fg("muted", verbsOf(record, cwd).running);
		return `${INDENT}${head} ${theme.fg("dim", detail)}`;
	}

	return settledSentence(record, cwd, false, maxWidth);
}

function settledSentence(
	record: ActivityRecord,
	cwd: string,
	highlighted: boolean,
	maxWidth: number,
): string {
	const { done } = verbsOf(record, cwd);
	const target = targetText(record, cwd, false, maxWidth);

	if (record.status === "error") {
		const head = theme.fg("error", failedVerb(record));
		const name = target ? ` ${theme.fg("error", target)}` : "";
		return `${INDENT}${head}${name}`;
	}

	const rest = [target, tailText(record)].filter(Boolean).join("  ");

	if (highlighted) {
		const head = theme.fg("text", theme.bold(done));
		return rest ? `${INDENT}${head} ${theme.fg("dim", rest)}` : `${INDENT}${head}`;
	}

	return `${INDENT}${theme.fg("dim", rest ? `${done} ${rest}` : done)}`;
}

function getCounts(record: ActivityRecord): LiveCounts | undefined {
	if (record.name === "write") {
		const content = argsOf(record).content;
		return typeof content === "string" ? { added: lineCount(content), removed: 0 } : undefined;
	}

	if (record.name === "edit") return diffCounts(record) ?? streamedCounts(record);

	return undefined;
}

function counterText(record: ActivityRecord, counts: LiveCounts): string {
	if (record.name === "write") {
		return counts.added > 0 ? `+${counts.added}` : "";
	}

	if (counts.added === 0 && counts.removed === 0) return "";

	return `+${counts.added} -${counts.removed}`;
}

function tailText(record: ActivityRecord): string {
	switch (record.name) {
		case "read": {
			const lines = resultLines(record).length;
			return lines > 0 ? plural(lines, "line") : "";
		}
		case "edit": {
			const counts = diffCounts(record);
			return counts ? `+${counts.added} -${counts.removed}` : "";
		}
		case "write": {
			const created = detailsOf(record).created;
			if (created === true) return "";

			const counts = getCounts(record);
			return counts && counts.added > 0 ? `+${counts.added}` : "";
		}
		case "grep":
		case "websearch": {
			const lines = resultLines(record).length;
			return lines > 0 ? plural(lines, "match", "matches") : "";
		}
		case "find":
		case "glob": {
			const lines = resultLines(record).length;
			return lines > 0 ? plural(lines, "file") : "";
		}
		default:
			return "";
	}
}

function highlight(word: string, phase: number): string {
	const period = word.length + HIGHLIGHT_WIDTH * 2;
	const head = (phase % period) - HIGHLIGHT_WIDTH;
	let out = "";

	for (let index = 0; index < word.length; index++) {
		const letter = word[index] ?? "";
		const distance = Math.abs(index - head);

		if (distance === 0) out += theme.fg("text", letter);
		else if (distance === 1) out += theme.fg("accent", letter);
		else out += theme.fg("muted", letter);
	}

	return out;
}

function addDiff(oldText: string, newText: string, totals: LiveCounts): void {
	for (const part of diffLines(oldText, newText)) {
		if (!part.added && !part.removed) continue;

		const lines = part.value.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();

		if (part.added) totals.added += lines.length;
		else totals.removed += lines.length;
	}
}

function verbsOf(record: ActivityRecord, cwd?: string): { running: string; done: string } {
	switch (record.name) {
		case "read":
			return { running: "reading", done: "read" };
		case "grep":
		case "find":
		case "glob":
		case "websearch":
			return { running: "searching", done: "search" };
		case "ls":
			return { running: "listing", done: "list" };
		case "webfetch":
			return { running: "fetching", done: "fetch" };
		case "edit":
			return { running: "editing", done: "edit" };
		case "write": {
			const created = detailsOf(record).created;
			if (created === true) return { running: "writing", done: "create" };
			if (created === false) return { running: "editing", done: "edit" };

			// Existing file.
			if (isRunning(record) && cwd && writeExists(record, cwd)) {
				return { running: "editing", done: "edit" };
			}

			return { running: "writing", done: "write" };
		}
		case "bash":
			return { running: "running", done: "bash" };
		case "powershell":
			return { running: "running", done: "powershell" };
		default:
			return { running: "working", done: shortName(record.name) };
	}
}

function targetText(
	record: ActivityRecord,
	cwd: string,
	withName = false,
	maxWidth = Number.POSITIVE_INFINITY,
): string {
	if (record.name === "bash" || record.name === "powershell") {
		return clipPlain(commandOf(record), maxWidth);
	}

	const path = activityTargetPath(record);
	if (path) return formatPathRelativeToCwdOrAbsolute(path, cwd);

	if (record.name === "ls") return ".";

	// No path.
	if (withName && !PATH_TOOLS.has(record.name)) return shortName(record.name);

	return "";
}

function diffCounts(record: ActivityRecord): LiveCounts | undefined {
	const diff = detailsOf(record).diff;
	if (typeof diff !== "string" || !diff.trim()) return undefined;

	let added = 0;
	let removed = 0;

	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;

		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}

	return { added, removed };
}

function streamedCounts(record: ActivityRecord): LiveCounts {
	const totals: LiveCounts = { added: 0, removed: 0 };

	const addEdit = (oldText: unknown, newText: unknown) => {
		if (typeof oldText !== "string") return;

		if (typeof newText === "string") addDiff(oldText, newText, totals);
		else totals.removed += lineCount(oldText);
	};

	const args = argsOf(record);

	if (Array.isArray(args.edits)) {
		for (const entry of args.edits) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

			const { oldText, newText } = entry as Record<string, unknown>;

			addEdit(oldText, newText);
		}
	} else {
		addEdit(args.oldText, args.newText);
	}

	return totals;
}

function clipPlain(value: string, width: number): string {
	if (visibleWidth(value) <= width) return value;
	if (width <= 1) return "…";

	return `${sliceByColumn(value, 0, width - 1)}…`;
}

function editLength(entry: unknown): string {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";

	const edit = entry as Record<string, unknown>;

	return `${textLength(edit.oldText)}:${textLength(edit.newText)}`;
}

function countKey(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";

	const values = args as Record<string, unknown>;
	const edits = Array.isArray(values.edits) ? values.edits.map(editLength).join(",") : "";

	const contentLength = textLength(values.content);
	const oldLength = textLength(values.oldText);
	const newLength = textLength(values.newText);

	return `${contentLength}|${edits}|${oldLength}:${newLength}`;
}

export class ActivityLineComponent implements Component {
	readonly record: ActivityRecord;

	private expanded = false;
	private readonly getCwd: () => string;
	private readonly ui?: TUI;

	private highlightTimer?: ReturnType<typeof setTimeout>;
	private settleUntil = 0;

	private strikeStart?: number;
	private strikeTimer?: ReturnType<typeof setTimeout>;

	private cache?: { args: unknown; key: string; status: string; counts?: LiveCounts };

	private visibleAt = 0;
	private settleSeen = false;
	private holdUntil = 0;
	private holdCounts?: LiveCounts;

	constructor(options: { record: ActivityRecord; cwd?: () => string; ui?: TUI }) {
		this.record = options.record;
		this.getCwd = options.cwd ?? (() => process.cwd());
		this.ui = options.ui;
	}

	get isExpanded(): boolean {
		return this.expanded;
	}

	refresh(): void {}

	invalidate(): void {}

	dispose(): void {
		if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer);
		this.highlightTimer = undefined;

		if (this.strikeTimer !== undefined) clearTimeout(this.strikeTimer);
		this.strikeTimer = undefined;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	toggleExpanded(): void {
		this.expanded = !this.expanded;
	}

	render(width: number): string[] {
		const maxWidth = Math.max(0, Math.floor(width));
		const now = Date.now();

		if (isRunning(this.record)) {
			if (!runningTarget(this.record, this.getCwd(), maxWidth)) {
				return [];
			}
			if (!this.visibleAt) {
				this.visibleAt = now;
			}

			const verb = verbsOf(this.record, this.getCwd()).running;
			const clip = this.commandClip(maxWidth, verb);
			const sentence = this.runningSentence(this.liveCounts(), clip);

			this.armHighlight();

			return this.withBody(sentence, maxWidth);
		}

		// Read pause.
		this.startHold(now);

		if (this.holdUntil > now) {
			const verb = verbsOf(this.record, this.getCwd()).running;
			const clip = this.commandClip(maxWidth, verb);
			const sentence = this.runningSentence(this.holdCounts, clip);

			this.armHighlight();

			return this.withBody(sentence, maxWidth);
		}

		if (this.holdUntil) {
			this.holdUntil = 0;
			this.settleUntil = now + HIGHLIGHT_HOLD;
		}

		const highlighted = this.isHighlighted();
		const verb = verbsOf(this.record, this.getCwd()).done;
		const clip = this.commandClip(maxWidth, verb);
		const sentence = settledSentence(this.record, this.getCwd(), highlighted, clip);

		if (highlighted) this.armHighlight(Math.max(0, this.settleUntil - now));

		return this.withBody(sentence, maxWidth);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y < 0) return undefined;

		this.toggleExpanded();

		return { handled: true, focus: true, render: true };
	}

	private commandClip(width: number, verb: string): number {
		if (this.expanded) return Number.POSITIVE_INFINITY;

		return Math.max(16, width - INDENT.length - verb.length - 5);
	}

	private isHighlighted(): boolean {
		return this.settleUntil > Date.now();
	}

	private isVisuallyRunning(): boolean {
		return isRunning(this.record) || this.holdUntil > Date.now();
	}

	private armHighlight(delay = HIGHLIGHT_FRAME): void {
		if (this.highlightTimer !== undefined || !this.ui) return;

		this.highlightTimer = setTimeout(() => {
			this.highlightTimer = undefined;
			this.ui?.requestRender();

			if (this.isVisuallyRunning()) {
				this.armHighlight();
			} else if (this.isHighlighted()) {
				this.armHighlight(Math.max(0, this.settleUntil - Date.now()));
			}
		}, delay);

		this.highlightTimer.unref?.();
	}

	private startHold(now: number): void {
		if (this.settleSeen) return;
		this.settleSeen = true;

		const counts = getCounts(this.record);

		if (!this.canHold(now, counts)) {
			if (this.visibleAt) {
				this.settleUntil = now + HIGHLIGHT_HOLD;
			}
			return;
		}

		const start = this.visibleAt > 0 ? this.visibleAt : now;
		this.holdUntil = start + READ_FLOOR;
		this.holdCounts = counts;
	}

	private canHold(now: number, counts: LiveCounts | undefined): boolean {
		if (!counts || this.record.status === "error" || this.expanded) return false;
		if (counts.added === 0 && counts.removed === 0) return false;

		const seenFor = this.visibleAt > 0 ? now - this.visibleAt : now - this.record.timestamp;

		return seenFor < (this.visibleAt > 0 ? READ_FLOOR : LIVE_ROW);
	}

	private runningSentence(counts: LiveCounts | undefined, maxWidth: number): string {
		const phase = Math.floor(Date.now() / HIGHLIGHT_FRAME);
		const head = highlight(verbsOf(this.record, this.getCwd()).running, phase);
		const detail = runningText(this.record, this.getCwd(), counts, maxWidth);

		return detail ? `${INDENT}${head} ${theme.fg("dim", detail)}` : `${INDENT}${head}`;
	}

	private withBody(sentence: string, width: number): string[] {
		const rows: string[] = this.expanded ? renderCardBodyRows(this.record) : [];

		const shown = rows.slice(0, EXPAND_MAX).map((row) => `${BODY_INDENT}${row}`);
		const hidden = rows.length - EXPAND_MAX;

		if (hidden > 0) shown.push(`${BODY_INDENT}… +${hidden} more lines`);

		// Shared width.
		const bodyWidth =
			shown.length > 0
				? Math.min(width, Math.max(24, ...shown.map((row) => visibleWidth(` ${row} `))))
				: 0;
		const cardWidth = Math.min(width, Math.max(this.sentenceWidth(sentence, width), bodyWidth));
		const lines = this.cardBlock(sentence, cardWidth);

		if (shown.length > 0) lines.push(...this.bodyBlock(shown, cardWidth));

		return lines;
	}

	private bodyBlock(rows: string[], cardWidth: number): string[] {
		const bg = this.cardBg();
		const blank = theme.bg(bg, " ".repeat(cardWidth));

		const body = rows.map((row) => {
			const clipped = clipToWidth(` ${row} `, cardWidth);
			const fill = " ".repeat(Math.max(0, cardWidth - visibleWidth(clipped)));

			return theme.bg(bg, `${keepCardBg(bg, `${clipped}\x1b[0m`)}${fill}`);
		});

		return [blank, ...body, blank];
	}

	private cardBg(): CardBg {
		if (this.record.status === "error") return "toolErrorBg";
		if (this.record.status === "success") return "toolSuccessBg";

		return "toolPendingBg";
	}

	private sentenceWidth(sentence: string, width: number): number {
		const body = this.record.status === "error" ? this.struckSentence(sentence) : sentence;

		return Math.min(width, Math.max(28, visibleWidth(clipToWidth(body, width)) + 2));
	}

	private cardBlock(sentence: string, cardWidth: number): string[] {
		const body = this.record.status === "error" ? this.struckSentence(sentence) : sentence;
		const rows = this.expanded
			? this.wrappedRows(body, cardWidth)
			: [clipToWidth(body, cardWidth)];
		const bg = this.cardBg();

		const text = rows.map((row) => {
			const clipped = clipToWidth(row, cardWidth);
			const fill = " ".repeat(Math.max(0, cardWidth - visibleWidth(clipped)));

			return theme.bg(bg, `${keepCardBg(bg, `${clipped}\x1b[0m`)}${fill}`);
		});

		const padding = theme.bg(bg, " ".repeat(cardWidth));

		return [padding, ...text, padding];
	}

	private wrappedRows(body: string, cardWidth: number): string[] {
		const indent = /^\s*/.exec(stripAnsi(body))?.[0] ?? "";
		const content = body.slice(indent.length);
		const width = Math.max(1, cardWidth - indent.length - 2);

		return wrapTextWithAnsi(content, width).map((row) => `${indent}${row}`);
	}

	private struckSentence(sentence: string): string {
		const plain = stripAnsi(sentence).replace(/\s+$/, "");
		const indent = /^\s*/.exec(plain)?.[0] ?? "";
		const command = plain.slice(indent.length);
		const now = Date.now();

		this.strikeStart ??= now;

		const progress = this.ui ? Math.min(1, (now - this.strikeStart) / STRIKE_DRAW_MS) : 1;

		if (progress < 1) {
			this.armStrike();
		}

		const cut = Math.round(command.length * progress);
		const head =
			cut > 0 ? `\x1b[1m\x1b[9m${theme.fg("error", command.slice(0, cut))}\x1b[0m` : "";
		const tail = theme.fg("error", command.slice(cut));

		return `${indent}${head}${tail}`;
	}

	private armStrike(): void {
		if (this.strikeTimer !== undefined || !this.ui) return;

		this.strikeTimer = setTimeout(() => {
			this.strikeTimer = undefined;
			this.ui?.requestRender();
		}, STRIKE_FRAME);

		this.strikeTimer.unref?.();
	}

	private liveCounts(): LiveCounts | undefined {
		const key = countKey(this.record.args);
		const cached = this.cache;

		if (
			cached &&
			cached.args === this.record.args &&
			cached.key === key &&
			cached.status === this.record.status
		) {
			return cached.counts;
		}

		const counts = getCounts(this.record);
		this.cache = { args: this.record.args, key, status: this.record.status, counts };

		return counts;
	}
}

export class ActivityTickerComponent implements Component {
	private records: ActivityRecord[] = [];
	private readonly ui: TUI;
	private readonly cwd: () => string;

	constructor(options: { ui: TUI; cwd?: () => string }) {
		this.ui = options.ui;
		this.cwd = options.cwd ?? (() => process.cwd());
	}

	get recordCount(): number {
		return this.records.length;
	}

	get isSettled(): boolean {
		return true;
	}

	add(record: ActivityRecord): void {
		this.records.push(record);
		this.ui.requestRender();
	}

	update(record: ActivityRecord): void {
		const index = this.records.findIndex((item) => item.toolCallId === record.toolCallId);
		if (index === -1) return;

		this.records[index] = record;
		this.ui.requestRender();
	}

	settle(): void {}

	reset(): void {
		this.records = [];
		this.ui.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const maxWidth = Math.max(0, Math.floor(width));
		const cwd = this.cwd();

		return this.records
			.map((record) => clipToWidth(formatActivityLine(record, cwd, maxWidth), maxWidth))
			.filter((line) => line.length > 0);
	}

	handleInput(): boolean {
		return false;
	}

	handleMouse(): TuiMouseEventResult | undefined {
		return undefined;
	}
}
