import { existsSync } from "node:fs";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@huranth/gama-tui";
import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@huranth/gama-tui";
import { diffLines } from "diff";
import { formatHandFailureBody, handFailureNext } from "../../core/hand-failure.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { getTextOutput } from "../../core/tools/render-utils.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { ANSI_RESET, theme } from "../theme/theme.ts";
import { handKindColor, handStatusPaint } from "./hand-colors.ts";
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
	matchCount?: number;
	resultCount?: number;
	results?: number;
}

type CardBg = "toolErrorBg" | "toolSuccessBg" | "toolPendingBg" | "handBg";

const HANDS_CARD_WIDTH = 64;

const HANDS_MAX_NAMES = 3;

const HANDS_START_MAX_ROLES = 6;

const INDENT = "  ";

const BODY_INDENT = "    ";

const EXPANDED_LINE_LIMIT = 200;

const MINIMUM_READ_MS = 650;

const LIVE_ROW_WINDOW_MS = 2000;

const STRIKE_DRAW_MS = 220;

const STRIKE_FRAME_MS = 40;

const HIGHLIGHT_FRAME_MS = 110;

const HIGHLIGHT_WIDTH = 2;

const HIGHLIGHT_HOLD_MS = 220;

const MINIMUM_COMMAND_WIDTH = 16;

const SENTENCE_GAP = 5;

const MINIMUM_SENTENCE_WIDTH = 28;

const CARD_PAD = 2;

const MINIMUM_WRAP_WIDTH = 1;

const WRAP_PAD = 2;

const SHORT_NAME_WIDTH = 24;

const PATH_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "fetch", "edit", "write"]);

function cleanText(value: string): string {
	return stripAnsi(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function keepCardBg(bg: CardBg, text: string): string {
	const ansi = theme.getBgAnsi(bg);
	return text.split(ANSI_RESET).join(`${ANSI_RESET}${ansi}`);
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

function capitalize(value: string): string {
	return value.replace(/^./, (letter) => letter.toUpperCase());
}

function handsActionOf(record: ActivityRecord): string {
	const action = argsOf(record).action;
	return typeof action === "string" ? action : "";
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

interface HandSummary {
	id?: string;
	title: string;
	kind?: string;
	status?: string;
	chars: number;
}

interface HandsInfo {
	action: string;
	hand?: string;
	total: number;
	delivered: number;
	collected: number;
	deliveredHands: HandSummary[];
	collectedHands: HandSummary[];
	kinds: string[];
	running: number;
	chars: number;
}

function handsInfoOf(record: ActivityRecord): HandsInfo {
	const args = argsOf(record);
	const details = objectOf(record.result?.details);
	const snapshots = Array.isArray(details?.hands) ? details.hands : [];
	const argsHands = Array.isArray(args.hands) ? args.hands : [];
	const action = handsActionOf(record);
	const hand = typeof args.hand === "string" ? args.hand.trim() : undefined;
	const deliveredIds = new Set(
		Array.isArray(details?.delivered)
			? details.delivered.filter((id): id is string => typeof id === "string")
			: [],
	);
	const rawCollected = Array.isArray(details?.collected) ? details.collected : details?.delivered;
	const collectedIds = new Set(
		Array.isArray(rawCollected)
			? rawCollected.filter((id): id is string => typeof id === "string")
			: [],
	);
	const allHands: HandSummary[] = [];
	let running = 0;

	for (const value of snapshots) {
		const snapshot = objectOf(value);
		if (!snapshot) continue;
		const status = typeof snapshot.status === "string" ? snapshot.status : undefined;
		if (status === "running") running++;
		allHands.push({
			id: typeof snapshot.id === "string" ? snapshot.id : undefined,
			title: typeof snapshot.title === "string" ? snapshot.title : "hand",
			kind: typeof snapshot.kind === "string" ? snapshot.kind : undefined,
			status,
			chars: typeof snapshot.result === "string" ? snapshot.result.length : 0,
		});
	}

	const kinds = allHands
		.map((snapshot) => snapshot.kind)
		.filter((kind): kind is string => Boolean(kind));
	if (kinds.length === 0) {
		for (const value of argsHands) {
			const kind = objectOf(value)?.kind;
			if (typeof kind === "string") kinds.push(kind);
		}
	}

	const collectedHands = allHands.filter(
		(snapshot) => snapshot.id && collectedIds.has(snapshot.id),
	);
	const deliveredHands = allHands.filter(
		(snapshot) => snapshot.id && deliveredIds.has(snapshot.id),
	);
	if (action === "read" && deliveredHands.length === 0) {
		const match = allHands.find((snapshot) => snapshot.title === hand) ?? allHands[0];
		if (match) {
			deliveredHands.push(match);
			if (match.id && !collectedIds.has(match.id)) {
				collectedIds.add(match.id);
				collectedHands.push(match);
			}
		}
	}

	const total =
		snapshots.length ||
		argsHands.length ||
		(action === "read" || (action === "wait" && hand) ? 1 : 0);

	return {
		action,
		hand,
		total,
		delivered: deliveredIds.size,
		collected: collectedIds.size,
		deliveredHands,
		collectedHands,
		kinds,
		running,
		chars: deliveredHands[0]?.chars ?? collectedHands[0]?.chars ?? 0,
	};
}

function handFailureRows(record: ActivityRecord): string[] {
	return formatHandFailureBody(
		stripAnsi(getTextOutput(record.result, false)),
		handFailureNext(handsActionOf(record)),
	).split("\n");
}

function handsTarget(record: ActivityRecord, maxWidth: number): string {
	const info = handsInfoOf(record);
	if (info.hand) return clipPlain(cleanText(info.hand), maxWidth);

	if (info.action === "wait") {
		if (isRunning(record)) {
			return info.total > 1 ? `the first of ${plural(info.total, "hand")}` : "a hand";
		}
		if (info.collected > 0) {
			return info.collected === info.total
				? plural(info.total, "hand")
				: `${info.collected} of ${plural(info.total, "hand")}`;
		}
		return info.total > 0 ? "all hands" : "hands";
	}

	return info.total > 0 ? plural(info.total, "hand") : "hands";
}

function handNames(info: HandsInfo): string {
	const names = info.collectedHands.slice(0, HANDS_MAX_NAMES).map((hand) => hand.title);
	const rest = info.collectedHands.length - names.length;
	if (rest > 0) names.push(`+${rest}`);
	return names.join(", ");
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
	return clipToWidth(first || text, SHORT_NAME_WIDTH);
}

export function activityKind(toolName: string): ActivityKind {
	switch (toolName) {
		case "read":
		case "grep":
		case "find":
		case "glob":
		case "ls":
		case "outline":
		case "fetch":
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
		case "outline":
			return "failed to outline";
		case "bash":
		case "powershell":
			return "failed to run";
		case "fetch":
			return "failed to fetch";
		case "hands":
			return `failed to ${handsActionOf(record) || "use"}`;
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

function visibleResultLines(record: ActivityRecord): string[] {
	return resultLines(record).filter((line) => {
		const text = line.trim();
		if (!text) return false;
		return !/^\[(?:Showing lines |\d+ more lines|Line \d+ is )/.test(text);
	});
}

function tailText(record: ActivityRecord): string {
	switch (record.name) {
		case "read": {
			const lines = visibleResultLines(record).length;
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
		case "grep": {
			const count = detailsOf(record).matchCount ?? visibleResultLines(record).length;
			return count > 0 ? plural(count, "match", "matches") : "";
		}
		case "find":
		case "glob": {
			const count = detailsOf(record).resultCount ?? visibleResultLines(record).length;
			return count > 0 ? plural(count, "file") : "";
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
			return { running: "searching", done: "search" };
		case "ls":
			return { running: "listing", done: "list" };
		case "outline":
			return { running: "outlining", done: "outline" };
		case "fetch":
			return { running: "fetching", done: "fetch" };
		case "edit":
			return { running: "editing", done: "edit" };
		case "write": {
			const created = detailsOf(record).created;
			if (created === true) return { running: "writing", done: "create" };
			if (created === false) return { running: "editing", done: "edit" };

			if (isRunning(record) && cwd && writeExists(record, cwd)) {
				return { running: "editing", done: "edit" };
			}

			return { running: "writing", done: "write" };
		}
		case "bash":
			return { running: "running", done: "bash" };
		case "powershell":
			return { running: "running", done: "powershell" };
		case "hands": {
			switch (handsActionOf(record)) {
				case "read":
					return { running: "reading", done: "read" };
				case "wait":
					return { running: "waiting for", done: "collected" };
				case "note":
					return { running: "noting", done: "noted" };
				case "talk":
					return { running: "talking to", done: "talked to" };
				case "merge":
					return { running: "merging", done: "merged" };
				case "finish":
					return { running: "closing", done: "closed" };
				case "start":
					return { running: "starting", done: "started" };
				default:
					return { running: "working on", done: "used" };
			}
		}
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
	if (record.name === "hands") return handsTarget(record, maxWidth);

	if (record.name === "bash" || record.name === "powershell") {
		return clipPlain(commandOf(record), maxWidth);
	}

	const path = activityTargetPath(record);
	if (path) {
		if (record.name === "fetch") return clipPlain(path, maxWidth);
		return formatPathRelativeToCwdOrAbsolute(path, cwd);
	}

	if (record.name === "ls") return ".";

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
	if (width <= 1) return "...";

	return `${sliceByColumn(value, 0, width - 1)}...`;
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
	record: ActivityRecord;

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

	setRecord(record: ActivityRecord): void {
		this.record = record;
		this.cache = undefined;
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

		// Read pause
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
			this.settleUntil = now + HIGHLIGHT_HOLD_MS;
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
		if (this.record.name === "hands" && this.record.status !== "error") return undefined;

		this.toggleExpanded();

		return { handled: true, focus: true, render: true };
	}

	private commandClip(width: number, verb: string): number {
		if (this.expanded) return Number.POSITIVE_INFINITY;

		return Math.max(MINIMUM_COMMAND_WIDTH, width - INDENT.length - verb.length - SENTENCE_GAP);
	}

	private isHighlighted(): boolean {
		return this.settleUntil > Date.now();
	}

	private isVisuallyRunning(): boolean {
		return isRunning(this.record) || this.holdUntil > Date.now();
	}

	private armHighlight(delay = HIGHLIGHT_FRAME_MS): void {
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
				this.settleUntil = now + HIGHLIGHT_HOLD_MS;
			}
			return;
		}

		const start = this.visibleAt > 0 ? this.visibleAt : now;
		this.holdUntil = start + MINIMUM_READ_MS;
		this.holdCounts = counts;
	}

	private canHold(now: number, counts: LiveCounts | undefined): boolean {
		if (!counts || this.record.status === "error" || this.expanded) return false;
		if (counts.added === 0 && counts.removed === 0) return false;

		const seenFor = this.visibleAt > 0 ? now - this.visibleAt : now - this.record.timestamp;

		return seenFor < (this.visibleAt > 0 ? MINIMUM_READ_MS : LIVE_ROW_WINDOW_MS);
	}

	private runningSentence(counts: LiveCounts | undefined, maxWidth: number): string {
		const phase = Math.floor(Date.now() / HIGHLIGHT_FRAME_MS);
		const head = highlight(verbsOf(this.record, this.getCwd()).running, phase);
		const detail = runningText(this.record, this.getCwd(), counts, maxWidth);

		return detail ? `${INDENT}${head} ${theme.fg("dim", detail)}` : `${INDENT}${head}`;
	}

	private withBody(sentence: string, width: number): string[] {
		if (this.record.name === "hands" && this.record.status !== "error") {
			const action = handsActionOf(this.record);
			if (action === "wait" || action === "read") return this.handsBlock(width);
			if (action === "start") return this.startBlock(width);
		}

		const rows = this.bodyRows();
		// Fixed width
		const cardWidth = this.expanded
			? width
			: Math.min(width, this.sentenceWidth(sentence, width));
		const lines = this.cardBlock(sentence, cardWidth);

		if (rows.length > 0) lines.push(...this.bodyBlock(rows, cardWidth));

		return lines;
	}

	private bodyRows(): string[] {
		if (!this.expanded) return [];
		if (this.record.name !== "hands") return renderCardBodyRows(this.record);
		if (this.record.status !== "error") return [];
		return handFailureRows(this.record);
	}

	private handsBlock(width: number): string[] {
		const info = handsInfoOf(this.record);
		const cardWidth = Math.min(width, HANDS_CARD_WIDTH);
		if (cardWidth < 1) return [];

		const rows: string[] = [];

		if (info.action === "wait") {
			const total = info.total || info.collected;
			const names = handNames(info);
			if (isRunning(this.record)) {
				rows.push(`${INDENT}${theme.fg("text", theme.bold("Waiting"))}`);
				if (total > 0) {
					rows.push(
						`${INDENT}${theme.fg("muted", `${info.collected} of ${total}`)}${
							names ? `  ${theme.fg("muted", names)}` : ""
						}`,
					);
				}
			} else {
				rows.push(
					`${INDENT}${theme.fg(
						"success",
						theme.bold(total > 0 ? `${info.collected} of ${total} collected` : "Collected"),
					)}`,
				);
				if (names) rows.push(`${INDENT}${theme.fg("muted", names)}`);
			}
		} else {
			const hand = info.deliveredHands[0];
			const title =
				info.hand ?? hand?.title ?? (info.total > 0 ? plural(info.total, "hand") : "Hand");
			const status = isRunning(this.record) ? "Reading" : "Done";
			const chars = info.chars > 0 ? `${info.chars.toLocaleString()} chars` : "";
			rows.push(`${INDENT}${theme.fg("accent", theme.bold("Reading"))}`);
			rows.push(`${INDENT}${theme.fg(handKindColor(hand?.kind), title)}`);
			rows.push(
				`${INDENT}${handStatusPaint(hand?.status, status)}${
					chars ? `   ${theme.fg("muted", chars)}` : ""
				}`,
			);
		}

		return this.cardRows(rows, cardWidth);
	}

	private startBlock(width: number): string[] {
		const info = handsInfoOf(this.record);
		const cardWidth = Math.min(width, HANDS_CARD_WIDTH);
		if (cardWidth < 1) return [];

		const total = info.total || info.kinds.length;
		const rows = [`${INDENT}${theme.fg("text", theme.bold(`${plural(total, "hand")} started`))}`];
		const roles = info.kinds
			.slice(0, HANDS_START_MAX_ROLES)
			.map((kind) => theme.fg(handKindColor(kind), capitalize(kind)));
		const rest = Math.max(0, total - roles.length);
		if (rest > 0) roles.push(theme.fg("muted", `+${rest}`));
		if (roles.length > 0) rows.push(`${INDENT}${roles.join(", ")}`);

		return this.cardRows(rows, cardWidth);
	}

	private cardRows(rows: string[], cardWidth: number): string[] {
		const bg = this.cardBg();
		const padding = theme.bg(bg, " ".repeat(cardWidth));
		const text = rows.map((row) => {
			const clipped = clipToWidth(row, cardWidth);
			const fill = " ".repeat(Math.max(0, cardWidth - visibleWidth(clipped)));

			return theme.bg(bg, `${keepCardBg(bg, `${clipped}${ANSI_RESET}`)}${fill}`);
		});

		return [padding, ...text, padding];
	}

	private bodyBlock(rows: string[], cardWidth: number): string[] {
		const bg = this.cardBg();
		const blank = theme.bg(bg, " ".repeat(cardWidth));
		const contentWidth = Math.max(1, cardWidth - 2 - BODY_INDENT.length);

		const wrapped = rows.flatMap((row) => {
			const content = row.startsWith(BODY_INDENT) ? row.slice(BODY_INDENT.length) : row;
			return wrapTextWithAnsi(content, contentWidth).map((line) => `${BODY_INDENT}${line}`);
		});
		const shown = wrapped.slice(0, EXPANDED_LINE_LIMIT);
		const hidden = wrapped.length - shown.length;
		if (hidden > 0) shown.push(`${BODY_INDENT}... +${hidden} more lines`);

		const body = shown.map((row) => {
			const clipped = clipToWidth(` ${row} `, cardWidth);
			const fill = " ".repeat(Math.max(0, cardWidth - visibleWidth(clipped)));

			return theme.bg(bg, `${keepCardBg(bg, `${clipped}${ANSI_RESET}`)}${fill}`);
		});

		return [blank, ...body, blank];
	}

	private cardBg(): CardBg {
		if (this.record.name === "hands" && this.record.status !== "error") return "handBg";
		if (this.record.status === "error") return "toolErrorBg";
		if (this.record.status === "success") return "toolSuccessBg";

		return "toolPendingBg";
	}

	private sentenceWidth(sentence: string, width: number): number {
		const body = this.record.status === "error" ? this.struckSentence(sentence) : sentence;
		const clipped = visibleWidth(clipToWidth(body, width)) + CARD_PAD;

		return Math.min(width, Math.max(MINIMUM_SENTENCE_WIDTH, clipped));
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

			return theme.bg(bg, `${keepCardBg(bg, `${clipped}${ANSI_RESET}`)}${fill}`);
		});

		const padding = theme.bg(bg, " ".repeat(cardWidth));

		return [padding, ...text, padding];
	}

	private wrappedRows(body: string, cardWidth: number): string[] {
		const indent = /^\s*/.exec(stripAnsi(body))?.[0] ?? "";
		const content = body.slice(indent.length);
		const width = Math.max(MINIMUM_WRAP_WIDTH, cardWidth - indent.length - WRAP_PAD);

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
			cut > 0 ? theme.bold(theme.strikethrough(theme.fg("error", command.slice(0, cut)))) : "";
		const tail = theme.fg("error", command.slice(cut));

		return `${indent}${head}${tail}`;
	}

	private armStrike(): void {
		if (this.strikeTimer !== undefined || !this.ui) return;

		this.strikeTimer = setTimeout(() => {
			this.strikeTimer = undefined;
			this.ui?.requestRender();
		}, STRIKE_FRAME_MS);

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
