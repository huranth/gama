import type { AgentMessage } from "@huranth/gama-agent-core";
import type { AssistantMessage, Usage } from "@huranth/gama-ai";
import { Type } from "typebox";
import type { ToolDefinition } from "./ext/types.ts";
import {
	formatHandFailure,
	HAND_RUN_NEXT,
	HAND_START_NEXT,
	handFailureNext,
} from "./hand-failure.ts";

export const HANDS_TOOL_NAME = "hands";

export const MAX_HANDS = 10;

const MAX_HAND_CONTINUATIONS = 2;

const HAND_CONTINUATION_PROMPT =
	"Your previous reply was cut off by the output limit. Continue from exactly where it stopped. " +
	"Do not repeat any text already produced. Finish the complete artifact and explanation; " +
	"do not summarize, tail, or omit entries.";

export const HAND_KINDS = {
	scout: {
		description:
			"maps files, symbols, and entry points. Read-only; it gathers map " +
			"evidence, not bug conclusions.",
		tools: ["read", "grep", "find", "ls", "outline"],
		prompt:
			"You are a hand, not the coordinator. You only map structure. Never plan, delegate, or edit. " +
			"Use the file count a search or find tool reports for the exact glob; do " +
			"not estimate it from manifest line counts or arithmetic. " +
			"Reply in exactly this shape: a short clean title as a Markdown heading, " +
			'then "Agent content:" and the artifact in one fenced ```json block: ' +
			'{"files":[{"path","purpose","lines?"}],"symbols":[{"name","path","lines?"}],' +
			'"entryPoints":[]}, ' +
			'then "Explanation:" and 1-3 plain sentences for the user. Omit lines you ' +
			"did not verify.",
	},
	digger: {
		description:
			"investigates one subsystem or question deeply. Read-only; it returns " +
			"evidence and a confidence level, not a verified finding.",
		tools: ["read", "grep", "find", "ls", "outline"],
		prompt:
			"You are a hand, not the coordinator. You only read and trace. Never plan, delegate, or edit. " +
			"If a claim covers only a sample, say how many you checked; never " +
			"generalize it to all or every. " +
			"Reply in exactly this shape: a short clean title as a Markdown heading, " +
			'then "Agent content:" and the artifact in one fenced ```json block: ' +
			'{"claims":[{"claim","file","line?","evidence"}],"confidence":0,"openQuestions":[]}, ' +
			'then "Explanation:" and 1-3 plain sentences for the user. Use line only ' +
			"when verified and escape quotes inside strings.",
	},
	runner: {
		description: "runs one command, test, or build. No edits.",
		tools: ["bash", "powershell", "read", "grep", "find", "ls"],
		prompt:
			"You are a hand, not the coordinator. You only run the given command. " +
			"Never plan, delegate, or edit. " +
			"Reply in exactly this shape: a short clean title as a Markdown heading, " +
			'then "Agent content:" and the artifact in one fenced ```json block: ' +
			'{"command","exitCode","failingTests":[],"firstError","output","fullOutputPath"}, ' +
			'then "Explanation:" and 1-3 plain sentences for the user. ' +
			"`output` must be the complete command output, never a tail or excerpt. " +
			"If the tool saved the complete output to a file, set `fullOutputPath` to " +
			"that exact path; never replace `output` with only the tail.",
	},
	critic: {
		description:
			"independently verifies a specific claim, suspect, or diff. Read-only; " +
			"start it after a scout or digger, not as a first-pass search.",
		tools: ["read", "grep", "find", "ls", "outline", "bash"],
		prompt:
			"You are a hand, not the coordinator. You only verify the supplied " +
			"targets, claims, or diff. Never plan, delegate, edit, or widen scope. " +
			"For each target, try to refute the claim, cite the exact line that " +
			"proves or disproves it, and mark it confirmed, refuted, or unverified. " +
			"If the evidence is missing, name what is missing instead of guessing. " +
			"Reply in exactly this shape: a short clean title as a Markdown heading, " +
			'then "Agent content:" and the artifact in one fenced ```json block: ' +
			'{"findings":[{"severity","file","line?","problem","evidence","status"}],"verdict"}, ' +
			'then "Explanation:" and 1-3 plain sentences for the user. `status` must ' +
			"be confirmed, refuted, or unverified. Use line only when verified and " +
			"escape quotes inside strings.",
	},
	builder: {
		description: "makes the change, runs checks, and finishes it. The only role that edits.",
		tools: undefined,
		prompt:
			"You are a hand, not the coordinator. You are the only role that may edit. " +
			"Reply in exactly this shape: a short clean title as a Markdown heading, " +
			'then "Agent content:" and the artifact in one fenced ```json block: ' +
			'{"filesChanged":[],"testsRun":[],"patchSummary","remaining":[]}, then ' +
			'"Explanation:" and 1-3 plain sentences for the user.',
	},
} as const;

export type HandKind = keyof typeof HAND_KINDS;

export function handKindLabel(kind: HandKind): string {
	return `${kind} hand`;
}

const HAND_KIND_HELP = (Object.keys(HAND_KINDS) as HandKind[])
	.map((kind) => `${handKindLabel(kind)}: ${HAND_KINDS[kind].description}`)
	.join(" ");

function handInputMessage(
	kind: HandKind,
	input: Record<string, unknown>,
	note?: string,
	context?: string,
): string {
	const lines = Object.entries(input)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
	const contextBlock = context?.trim() ? `\n\nShared context:\n${context.trim()}` : "";
	const noteBlock = note?.trim() ? `\n\nCoordinator note:\n${note.trim()}` : "";
	return (
		`Role: ${kind}\n` +
		`${lines.join("\n")}${contextBlock}${noteBlock}\n\n` +
		"Do only your job. Return the JSON artifact."
	);
}

export const HAND_SYSTEM_PROMPT =
	`Hand reply style:\n` +
	"Work fully, then report like a compact handoff checkpoint. Answer first. " +
	"Keep only verified facts, exact paths and numbers, decisions, and " +
	"unresolved risks. One line per item, no preamble, no restating the task, " +
	"no raw file dumps, no offers to continue, and no permission questions. " +
	"Include file:line evidence when it changes the answer. If blocked, ask " +
	"one direct question. Aim for the shortest reply that still lets the main " +
	"agent act, usually 150-350 words. For a structured role, reply in " +
	"exactly this shape: a short clean title as a Markdown heading, then " +
	'"Agent content:" and the requested JSON object in one fenced block, ' +
	'then "Explanation:" and 1-3 plain sentences for the user. The JSON is ' +
	"the handoff; keep every entry to one line and never drop required " +
	"entries just to be short. Never truncate, tail, ellipsize, or replace a " +
	"required field with '...'. If a reply is cut off, continue from the cut " +
	"point and return one complete artifact. Put the explanation last, and " +
	"nothing after it. Use a count reported by a search or find result " +
	"directly; never reconstruct it from line arithmetic or invent it. If an " +
	"exact count is unavailable, report the best available count and how you " +
	"got it, then move on. Label inference as inference, and do not turn a " +
	"sample into all or every. Before returning JSON, escape quotes inside " +
	"strings and check that it parses.";

export type HandStatus = "running" | "done" | "failed" | "cancelled";

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("Aborted"));

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new Error("Aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export interface HandToolItem {
	role: "tool";
	id: string;
	toolCallId: string;
	timestamp?: number;
	name: string;
	args: unknown;
	status: "running" | "success" | "error";
	result?: { content: Array<{ type: string; text?: string }>; details?: unknown };
}

export type HandTranscriptItem =
	| { role: "user"; id: string; text: string; timestamp?: number }
	| {
			role: "assistant";
			id: string;
			message: AssistantMessage;
			streaming?: boolean;
			thinking?: { startedAt: number; endedAt?: number }[];
	  }
	| HandToolItem;

export interface HandSnapshot {
	id: string;
	index: number;
	title: string;
	kind: HandKind;
	task: string;
	status: HandStatus;
	transcript: HandTranscriptItem[];
	result?: string;
	error?: string;
	startedAt: number;
	finishedAt?: number;
}

export type HandsEvent =
	| { type: "hands_started"; hands: HandSnapshot[] }
	| { type: "hands_updated"; hand: HandSnapshot }
	| { type: "hands_finished"; hands: HandSnapshot[] };

export interface HandsDetails {
	hands: HandSnapshot[];
	delivered?: string[];
	collected?: string[];
}

export interface HandSession {
	readonly agent: {
		readonly state: {
			readonly messages: AgentMessage[];
			readonly streamingMessage?: AgentMessage;
		};
	};
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): void;
	dispose(): void;
}

export type CreateHandSession = (index: number, kind: HandKind) => Promise<HandSession>;

export interface HandsHost {
	createSession: CreateHandSession;
	emit(event: HandsEvent): void;
	wake?(text: string, handId: string): void;
	cancelWake?(handId: string): boolean;
	recordUsage?(provider: string, model: string, usage: Usage): void;
}

const ScoutInput = Type.Object({
	root: Type.String({ description: "Directory or file to map." }),
	question: Type.Optional(Type.String({ description: "What to map for." })),
});

const DiggerInput = Type.Object({
	target: Type.String({ description: "Path or symbol to trace." }),
	question: Type.String({ description: "What to answer." }),
});

const RunnerInput = Type.Object({
	command: Type.String({ description: "Command to run." }),
	timeout: Type.Optional(Type.Number({ description: "Seconds before abort." })),
});

const CriticInput = Type.Object({
	targets: Type.Optional(Type.Array(Type.String(), { description: "Files to review." })),
	diff: Type.Optional(Type.Boolean({ description: "Review the current diff." })),
	criteria: Type.Optional(Type.String({ description: "What to check." })),
});

const BuilderInput = Type.Object({
	goal: Type.String({ description: "Change to make." }),
	acceptance: Type.Optional(Type.String({ description: "How to verify it." })),
	scope: Type.Optional(Type.Array(Type.String(), { description: "Paths it may touch." })),
});

const HandStartParam = Type.Union(
	[
		Type.Object({
			kind: Type.Literal("scout"),
			input: ScoutInput,
			note: Type.Optional(
				Type.String({ description: "Coordinator note. Optional context or focus." }),
			),
		}),
		Type.Object({
			kind: Type.Literal("digger"),
			input: DiggerInput,
			note: Type.Optional(
				Type.String({ description: "Coordinator note. Optional context or focus." }),
			),
		}),
		Type.Object({
			kind: Type.Literal("runner"),
			input: RunnerInput,
			note: Type.Optional(
				Type.String({ description: "Coordinator note. Optional context or focus." }),
			),
		}),
		Type.Object({
			kind: Type.Literal("critic"),
			input: CriticInput,
			note: Type.Optional(
				Type.String({ description: "Coordinator note. Optional context or focus." }),
			),
		}),
		Type.Object({
			kind: Type.Literal("builder"),
			input: BuilderInput,
			note: Type.Optional(
				Type.String({ description: "Coordinator note. Optional context or focus." }),
			),
		}),
	],
	{ description: "A role and its typed input." },
);

const HandActionParam = Type.Union(
	[
		Type.Literal("start"),
		Type.Literal("read"),
		Type.Literal("wait"),
		Type.Literal("note"),
		Type.Literal("talk"),
		Type.Literal("merge"),
		Type.Literal("finish"),
	],
	{
		description:
			"start creates hands. read returns a character window of one hand's " +
			"artifact. wait collects artifacts. note queues a coordinator note " +
			"without waiting. talk sends one message and waits for its reply. merge " +
			"combines completed artifacts. finish closes hands after collection.",
	},
);

const HandsParams = Type.Object({
	action: HandActionParam,
	hands: Type.Optional(
		Type.Array(HandStartParam, {
			minItems: 1,
			maxItems: MAX_HANDS,
			description: "For action start: role plus typed input for each hand.",
		}),
	),
	hand: Type.Optional(
		Type.String({
			description:
				'For wait, talk, or finish: hand title such as "Hand 1". Omit to use all hands.',
		}),
	),
	message: Type.Optional(
		Type.String({
			description: "For action talk: the next message to send. One focused message at a time.",
		}),
	),
	context: Type.Optional(
		Type.String({
			description: "For action start: shared decisions or constraints added to every hand.",
			maxLength: 8000,
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description:
				"For action read: character offset to start from. Use the offset from the clip marker.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"For action read: optional maximum characters to return. Omit for the complete artifact.",
		}),
	),
});

const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])/g;

const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

const BINARY_PLACEHOLDER = "[binary or control data omitted]";

function sanitizeText(value: string): string {
	const text = value
		.replace(ANSI_SEQUENCE, "")
		.replace(CONTROL_CHARACTERS, "")
		.replace(/\r\n?/g, "\n");
	const broken = text.match(/\uFFFD/g)?.length ?? 0;
	if (broken > 8 && broken / Math.max(1, text.length) > 0.1) return BINARY_PLACEHOLDER;
	return text;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return sanitizeText(content);
	if (!Array.isArray(content)) return "";
	return sanitizeText(
		content
			.filter(
				(block): block is { type: "text"; text: string } =>
					typeof block === "object" &&
					block !== null &&
					(block as { type?: unknown }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text)
			.join("\n"),
	);
}

export function buildHandTranscript(
	messages: readonly AgentMessage[],
	streamingMessage?: AgentMessage,
	thinking?: ReadonlyMap<number, { startedAt: number; endedAt?: number }[]>,
): HandTranscriptItem[] {
	const items: HandTranscriptItem[] = [];
	const tools = new Map<string, HandToolItem[]>();
	const assistantCounts = new Map<number, number>();
	const userCounts = new Map<number, number>();
	const toolCounts = new Map<string, number>();

	const nextId = (
		prefix: string,
		base: string | number,
		counts: Map<string | number, number>,
	): string => {
		const seen = counts.get(base) ?? 0;
		counts.set(base, seen + 1);
		return `${prefix}:${base}:${seen}`;
	};

	const addAssistant = (message: AgentMessage, streaming = false): void => {
		const assistant = message as AssistantMessage;
		items.push({
			role: "assistant",
			id: nextId("a", assistant.timestamp, assistantCounts),
			message: assistant,
			...(streaming ? { streaming: true } : {}),
			...(thinking ? { thinking: thinking.get(assistant.timestamp) } : {}),
		});
		for (const block of assistant.content ?? []) {
			if (block.type !== "toolCall") continue;
			const item: HandToolItem = {
				role: "tool",
				id: nextId("t", block.id, toolCounts),
				toolCallId: block.id,
				name: block.name,
				args: block.arguments,
				status: "running",
				timestamp: assistant.timestamp,
			};
			items.push(item);
			const queue = tools.get(block.id);
			if (queue) queue.push(item);
			else tools.set(block.id, [item]);
		}
	};

	for (const message of messages) {
		if (message.role === "system") continue;

		if (message.role === "user") {
			const text = textFromContent(message.content).trim();
			if (text) {
				items.push({
					role: "user",
					id: nextId("u", message.timestamp, userCounts),
					text,
					timestamp: message.timestamp,
				});
			}
			continue;
		}

		if (message.role === "assistant") {
			addAssistant(message);
			continue;
		}

		if (message.role === "toolResult") {
			const item = tools.get(message.toolCallId)?.shift();
			if (!item) {
				items.push({
					role: "tool",
					id: nextId("t", message.toolCallId, toolCounts),
					toolCallId: message.toolCallId,
					name: message.toolName,
					args: {},
					status: message.isError ? "error" : "success",
					timestamp: message.timestamp,
					result: {
						content: message.content.map((block) =>
							block.type === "text"
								? { type: "text", text: sanitizeText(block.text) }
								: block,
						),
						details: message.details,
					},
				});
				continue;
			}
			item.status = message.isError ? "error" : "success";
			item.result = {
				content: message.content.map((block) =>
					block.type === "text" ? { type: "text", text: sanitizeText(block.text) } : block,
				),
				details: message.details,
			};
		}
	}

	if (streamingMessage?.role === "assistant" && !messages.includes(streamingMessage)) {
		addAssistant(streamingMessage, true);
	}

	return items;
}

function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

function findHandError(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage || "Hand failed";
		if (message.stopReason === "aborted") return message.errorMessage || "Hand was aborted";
		return undefined;
	}
	return undefined;
}

function normalizeArtifact(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fenced?.[1] ?? text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			return JSON.stringify(JSON.parse(body.slice(start, end + 1)));
		} catch {}
	}
	return text;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function artifactOf(hand: HandSnapshot): JsonRecord | undefined {
	if (!hand.result) return undefined;
	try {
		return asRecord(JSON.parse(hand.result));
	} catch {
		return undefined;
	}
}

function addUnique(map: Map<string, unknown>, key: string, value: unknown): void {
	if (!map.has(key)) map.set(key, value);
}

function mergeHandArtifacts(hands: readonly HandSnapshot[]): string {
	const files = new Map<string, unknown>();
	const symbols = new Map<string, unknown>();
	const entryPoints = new Map<string, unknown>();
	const claims = new Map<string, unknown>();
	const openQuestions = new Map<string, unknown>();
	const findings = new Map<string, unknown>();
	const verdicts = new Map<string, unknown>();
	const unparsed: string[] = [];
	let scouts = 0;
	let diggers = 0;
	let critics = 0;
	let confidence: number | undefined;

	for (const hand of hands) {
		if (hand.status !== "done") continue;
		if (hand.kind !== "scout" && hand.kind !== "digger" && hand.kind !== "critic") continue;

		const artifact = artifactOf(hand);
		if (!artifact) {
			unparsed.push(hand.title);
			continue;
		}

		if (hand.kind === "scout") {
			scouts++;
			for (const item of asArray(artifact.files)) {
				const key = asString(asRecord(item)?.path) ?? JSON.stringify(item);
				addUnique(files, key, item);
			}
			for (const item of asArray(artifact.symbols)) {
				const record = asRecord(item);
				const key = `${asString(record?.name) ?? ""}\u0000${asString(record?.path) ?? ""}`;
				if (key !== "\u0000") addUnique(symbols, key, item);
			}
			for (const item of asArray(artifact.entryPoints)) {
				addUnique(entryPoints, JSON.stringify(item), item);
			}
			continue;
		}

		if (hand.kind === "digger") {
			diggers++;
			for (const item of asArray(artifact.claims)) {
				const record = asRecord(item);
				const key = `${asString(record?.claim) ?? ""}\u0000${
					asString(record?.file) ?? ""
				}\u0000${String(record?.line ?? "")}`;
				addUnique(claims, key, item);
			}
			for (const item of asArray(artifact.openQuestions)) {
				addUnique(openQuestions, JSON.stringify(item), item);
			}
			if (typeof artifact.confidence === "number" && Number.isFinite(artifact.confidence)) {
				confidence = Math.max(confidence ?? artifact.confidence, artifact.confidence);
			}
			continue;
		}

		critics++;
		for (const item of asArray(artifact.findings)) {
			const record = asRecord(item);
			const key = `${asString(record?.file) ?? ""}\u0000${String(
				record?.line ?? "",
			)}\u0000${asString(record?.problem) ?? ""}`;
			addUnique(findings, key, item);
		}
		if (artifact.verdict !== undefined) {
			addUnique(verdicts, JSON.stringify(artifact.verdict), artifact.verdict);
		}
	}

	if (scouts + diggers + critics === 0) {
		return unparsed.length > 0
			? `No mergeable artifacts. These hands did not return JSON: ${unparsed.join(", ")}.`
			: "No completed scout, digger, or critic artifacts to merge.";
	}

	return JSON.stringify({
		...(scouts > 0
			? {
					scout: {
						files: [...files.values()],
						symbols: [...symbols.values()],
						entryPoints: [...entryPoints.values()],
					},
				}
			: {}),
		...(diggers > 0
			? {
					digger: {
						claims: [...claims.values()],
						...(confidence === undefined ? {} : { confidence }),
						openQuestions: [...openQuestions.values()],
					},
				}
			: {}),
		...(critics > 0
			? {
					critic: {
						findings: [...findings.values()],
						verdicts: [...verdicts.values()],
					},
				}
			: {}),
		...(unparsed.length > 0 ? { unparsed } : {}),
	});
}

function stopRunningTools(hand: HandSnapshot): void {
	for (const item of hand.transcript) {
		if (item.role !== "tool" || item.status !== "running") continue;
		item.status = "error";
		item.result = { content: [{ type: "text", text: "No result" }] };
	}
}

function cloneItem(item: HandTranscriptItem): HandTranscriptItem {
	if (item.role === "assistant") {
		return {
			...item,
			message: {
				...item.message,
				content: item.message.content.map((block) => ({ ...block })),
			},
			thinking: item.thinking?.map((timing) => ({ ...timing })),
		};
	}
	if (item.role === "tool") {
		return {
			...item,
			result: item.result
				? {
						content: item.result.content.map((block) => ({ ...block })),
						details: item.result.details,
					}
				: undefined,
		};
	}
	return { ...item };
}

export function cloneHand(hand: HandSnapshot): HandSnapshot {
	return {
		...hand,
		transcript: hand.transcript.map(cloneItem),
	};
}

interface ResultWindow {
	text: string;
	offset: number;
	total: number;
	nextOffset?: number;
}

function resultWindow(text: string, offset: number, limit?: number): ResultWindow {
	const total = text.length;
	const start = Math.min(Math.max(0, offset), total);
	const end = limit === undefined ? total : Math.min(start + limit, total);
	return {
		text: text.slice(start, end),
		offset: start,
		total,
		...(end < total ? { nextOffset: end } : {}),
	};
}

function readWindow(
	offset: number | undefined,
	limit: number | undefined,
): { offset: number; limit: number | undefined } {
	const start = offset ?? 0;
	if (!Number.isInteger(start) || start < 0) {
		throw new Error("offset must be a non-negative integer.");
	}
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
		throw new Error("limit must be a positive integer.");
	}
	return { offset: start, limit };
}

function formatHand(hand: HandSnapshot, offset = 0, limit?: number): string {
	const header = `${hand.title} · ${handKindLabel(hand.kind)} (${hand.status})`;
	if (hand.status === "failed") {
		return `${header}\n${formatHandFailure(hand.error, HAND_RUN_NEXT)}`;
	}
	if (hand.status === "cancelled") {
		return `${header}\n${hand.error ?? "No result"}`;
	}
	if (hand.status === "running") {
		return `${header}\nStill working.`;
	}

	const window = resultWindow(hand.result ?? "Finished without a written result.", offset, limit);
	if (window.offset >= window.total && window.total > 0) {
		return `${header}\n[no more: artifact is ${window.total} characters.]`;
	}
	if (window.nextOffset === undefined) return `${header}\n${window.text}`;

	const shown = window.text.trimEnd();
	return `${header}\n${shown}\n\n[showing characters ${window.offset + 1}-${
		window.offset + window.text.length
	} of ${window.total}. Call action "read" hand "${hand.title}" offset ${
		window.nextOffset
	} for the rest.]`;
}

export function formatHandsSummary(
	hands: readonly HandSnapshot[],
	options?: { offset?: number; limit?: number },
): string {
	return hands.map((hand) => formatHand(hand, options?.offset ?? 0, options?.limit)).join("\n\n");
}

function formatHandFinished(hand: HandSnapshot): string {
	return `${formatHand(hand)}\n\nThe other hands may still be running.`;
}

function formatWaitSummary(
	hands: readonly HandSnapshot[],
	delivered: ReadonlySet<string>,
	limit?: number,
): string {
	const fresh = hands.filter((hand) => delivered.has(hand.id));
	const running = hands.filter((hand) => hand.status === "running").length;
	if (fresh.length === 0) {
		if (running > 0) {
			return `No new hand results. ${running} ${
				running === 1 ? "hand is" : "hands are"
			} still running; call action "wait" again.`;
		}
		return (
			"No new hand results. All finished hands are already collected; use " +
			'action "read" to view one again.'
		);
	}

	const body = fresh.map((hand) => formatHand(hand, 0, limit)).join("\n\n");
	if (running === 0) return body;
	return `${body}\n\n${running} ${
		running === 1 ? "hand is" : "hands are"
	} still running; call action "wait" to collect the next finished reply.`;
}

function formatStartedHands(hands: readonly HandSnapshot[]): string {
	const lines = hands.map((hand) =>
		hand.status === "failed"
			? `${hand.title} · ${handKindLabel(hand.kind)} failed to start\n${formatHandFailure(
					hand.error,
					HAND_START_NEXT,
				)}`
			: `${hand.title} · ${handKindLabel(hand.kind)} started`,
	);
	const hasUsableHand = hands.some((hand) => hand.status !== "failed");
	return `${lines.join("\n")}${
		hasUsableHand
			? `\nUse action "wait" to collect the next finished reply, then action "read" ` +
				'to inspect an artifact again or action "talk" with a hand title ' +
				"to keep the conversation going."
			: ""
	}`;
}

function overlapHint(
	tasks: ReadonlyArray<{ kind: HandKind; input: Record<string, unknown> }>,
): string | undefined {
	const normalize = (value: string): string =>
		value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	const roots = tasks
		.map((task, index) => ({
			title: `Hand ${index + 1}`,
			root:
				task.kind === "scout" && typeof task.input.root === "string"
					? normalize(task.input.root.trim())
					: "",
		}))
		.filter((item) => item.root);

	const overlaps: string[] = [];
	for (let left = 0; left < roots.length; left++) {
		for (let right = left + 1; right < roots.length; right++) {
			const a = roots[left]!;
			const b = roots[right]!;
			if (
				a.root === b.root ||
				a.root.startsWith(`${b.root}/`) ||
				b.root.startsWith(`${a.root}/`)
			) {
				overlaps.push(`${a.title} (${a.root}) and ${b.title} (${b.root})`);
			}
		}
	}
	if (overlaps.length === 0) return undefined;
	return (
		`Overlap warning: ${overlaps.join("; ")}. ` +
		"Assign distinct regions or expect duplicate entries."
	);
}

function refreshTranscript(
	hand: HandSnapshot,
	session: HandSession,
	thinkingTimes?: ReadonlyMap<number, { startedAt: number; endedAt?: number }[]>,
): void {
	const state = session.agent.state;
	hand.transcript = buildHandTranscript(state.messages, state.streamingMessage, thinkingTimes);
}

function thinkingRuns(message: AssistantMessage): { settled: boolean }[] {
	const runs: { settled: boolean }[] = [];
	for (let index = 0; index < message.content.length; ) {
		const block = message.content[index]!;
		if (block.type !== "thinking") {
			index++;
			continue;
		}

		let text = "";
		while (index < message.content.length) {
			const next = message.content[index]!;
			if (next.type !== "thinking") break;
			text += next.thinking;
			index++;
		}
		if (!text.trim()) continue;

		const following = message.content.slice(index);
		runs.push({
			settled: following.some(
				(next) =>
					(next.type === "text" && next.text.trim().length > 0) || next.type === "toolCall",
			),
		});
	}
	return runs;
}

interface WaitResult {
	hands: HandSnapshot[];
	delivered: Set<string>;
	collected: Set<string>;
}

interface LiveHand {
	snapshot: HandSnapshot;
	session: HandSession;
	queue: Promise<void>;
	unsubscribe: () => void;
	disposed: boolean;
	reported: boolean;
	collected: boolean;
	lastUpdate: number;
	counted: number;
	countedMessages: WeakSet<object>;
	thinkingTimes: Map<number, { startedAt: number; endedAt?: number }[]>;
}

class HandsRuntime {
	private readonly live = new Map<string, LiveHand>();
	private nextNumber = 0;
	private closed = false;

	private readonly host: HandsHost;

	constructor(host: HandsHost) {
		this.host = host;
	}

	// Listener safety
	private emit(event: HandsEvent): void {
		try {
			this.host.emit(event);
		} catch {}
	}

	async start(
		tasks: ReadonlyArray<{ kind: HandKind; input: Record<string, unknown>; note?: string }>,
		context?: string,
	): Promise<HandSnapshot[]> {
		if (this.closed) throw new Error("Hands closed");
		const running = [...this.live.values()].filter(
			(live) => live.snapshot.status === "running",
		).length;
		if (running + tasks.length > MAX_HANDS) {
			throw new Error(
				`Too many running hands: ${running} running + ` +
					`${tasks.length} requested exceeds ${MAX_HANDS}. ` +
					"Wait for a running hand to finish or close one, then retry.",
			);
		}
		const shared = context?.trim().slice(0, 8000);
		const startedAt = Date.now();
		const hands: HandSnapshot[] = tasks.map(({ kind, input, note }) => {
			const index = this.nextNumber++;
			const task = handInputMessage(kind, input, note, shared);
			const text = sanitizeText(task);
			return {
				id: `hand-${startedAt}-${index}`,
				index,
				title: `Hand ${index + 1}`,
				kind,
				task,
				status: "running",
				transcript: [{ role: "user", id: "task", text }],
				startedAt,
			};
		});

		this.emit({ type: "hands_started", hands: hands.map(cloneHand) });

		await Promise.all(
			hands.map(async (hand) => {
				try {
					const session = await this.host.createSession(hand.index, hand.kind);
					if (this.closed) {
						try {
							session.dispose();
						} catch {}
						return;
					}
					const live: LiveHand = {
						snapshot: hand,
						session,
						queue: Promise.resolve(),
						unsubscribe: () => {},
						disposed: false,
						reported: false,
						collected: false,
						lastUpdate: 0,
						counted: 0,
						countedMessages: new WeakSet(),
						thinkingTimes: new Map(),
					};
					live.unsubscribe = session.subscribe((event) =>
						this.handleSessionEvent(live, event),
					);
					this.live.set(hand.id, live);
					live.queue = this.runTurn(live, hand.task, true);
				} catch (error) {
					hand.status = "failed";
					hand.error = sanitizeText(error instanceof Error ? error.message : String(error));
					hand.finishedAt = Date.now();
					this.emit({ type: "hands_updated", hand: cloneHand(hand) });
					this.host.wake?.(formatHandFinished(hand), hand.id);
				}
			}),
		);

		const initialTurns = hands
			.map((hand) => this.live.get(hand.id)?.queue)
			.filter((queue): queue is Promise<void> => queue !== undefined);
		void Promise.all(initialTurns)
			.catch(() => undefined)
			.then(() => {
				if (this.closed) return;
				this.emit({ type: "hands_finished", hands: hands.map(cloneHand) });
			});

		return hands;
	}

	snapshots(): HandSnapshot[] {
		return [...this.live.values()].map((live) => live.snapshot);
	}

	read(handRef: string): HandSnapshot {
		if (!handRef.trim()) throw new Error("Missing hand title");
		const live = this.find(handRef)[0]!;
		if (live.snapshot.status !== "running") {
			live.reported = true;
			live.collected = true;
			this.host.cancelWake?.(live.snapshot.id);
		}
		return live.snapshot;
	}

	async wait(handRef?: string, signal?: AbortSignal): Promise<WaitResult> {
		const ref = handRef?.trim();
		if (ref) {
			const [live] = this.find(ref);
			const onAbort = () => live.session.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await raceAbort(live.queue, signal);
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
			live.reported = true;
			live.collected = true;
			this.host.cancelWake?.(live.snapshot.id);
			return {
				hands: [live.snapshot],
				delivered: new Set([live.snapshot.id]),
				collected: new Set([live.snapshot.id]),
			};
		}

		const targets = this.find();
		const onAbort = () => {
			for (const live of targets) live.session.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const canceledWakes = new Map<string, boolean>();
		const cancelWake = (live: LiveHand): boolean => {
			const cached = canceledWakes.get(live.snapshot.id);
			if (cached !== undefined) return cached;
			const canceled = this.host.cancelWake?.(live.snapshot.id) === true;
			canceledWakes.set(live.snapshot.id, canceled);
			return canceled;
		};
		const deliverable = (live: LiveHand): boolean =>
			live.snapshot.status !== "running" && (!live.reported || cancelWake(live));

		try {
			if (!targets.some((live) => deliverable(live))) {
				const pending = targets.filter((live) => !live.reported);
				if (pending.length > 0) {
					await raceAbort(
						Promise.race(
							pending.map((live) =>
								live.queue.then(
									() => undefined,
									() => undefined,
								),
							),
						),
						signal,
					);
				}
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		const delivered = new Set<string>();
		for (const live of targets) {
			if (!deliverable(live)) continue;
			live.reported = true;
			live.collected = true;
			delivered.add(live.snapshot.id);
		}
		const collected = new Set(
			targets.filter((live) => live.collected).map((live) => live.snapshot.id),
		);
		return { hands: targets.map((live) => live.snapshot), delivered, collected };
	}

	async note(handRef: string, message: string): Promise<HandSnapshot> {
		if (!handRef.trim()) throw new Error("Missing hand title");
		const [live] = this.find(handRef);
		const next = live.queue.then(() =>
			this.runTurn(
				live,
				`Coordinator note:
${message.trim()}`,
			),
		);
		live.queue = next.catch(() => undefined);
		return live.snapshot;
	}

	async talk(handRef: string, message: string, signal?: AbortSignal): Promise<HandSnapshot> {
		if (!handRef.trim()) throw new Error("Missing hand title");
		const [live] = this.find(handRef);
		const next = live.queue.then(() => this.runTurn(live, message));
		live.queue = next.catch(() => undefined);
		const onAbort = () => live.session.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await raceAbort(next, signal);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		live.reported = true;
		live.collected = true;
		this.host.cancelWake?.(live.snapshot.id);
		return live.snapshot;
	}

	finish(handRef?: string): HandSnapshot[] {
		const targets = this.find(handRef);
		for (const live of targets) {
			this.host.cancelWake?.(live.snapshot.id);
			try {
				this.recordUsage(live);
				refreshTranscript(live.snapshot, live.session, live.thinkingTimes);
			} catch {}
			live.disposed = true;
			try {
				live.unsubscribe();
			} catch {}
			if (live.snapshot.status === "running") {
				live.snapshot.status = "cancelled";
				live.snapshot.error = "Hand stopped";
			}
			stopRunningTools(live.snapshot);
			live.snapshot.finishedAt = Date.now();
			try {
				live.session.abort();
			} catch {}
			try {
				live.session.dispose();
			} catch {}
			this.live.delete(live.snapshot.id);
			this.emit({ type: "hands_updated", hand: cloneHand(live.snapshot) });
		}
		return targets.map((live) => live.snapshot);
	}

	dispose(): void {
		this.closed = true;
		for (const live of this.live.values()) {
			live.disposed = true;
			this.host.cancelWake?.(live.snapshot.id);
			try {
				live.unsubscribe();
			} catch {}
			try {
				live.session.abort();
			} catch {}
			try {
				live.session.dispose();
			} catch {}
		}
		this.live.clear();
	}

	private find(handRef?: string): LiveHand[] {
		const ref = handRef?.trim();
		if (!ref) {
			if (this.live.size === 0) throw new Error("No live hands");
			return [...this.live.values()];
		}
		const hand = [...this.live.values()].find(
			(live) =>
				live.snapshot.id === ref || live.snapshot.title.toLowerCase() === ref.toLowerCase(),
		);
		if (!hand) {
			const names = [...this.live.values()].map((live) => live.snapshot.title).join(", ");
			throw new Error(`No live hand: ${ref}${names ? ` (${names})` : ""}`);
		}
		return [hand];
	}

	private handleSessionEvent(live: LiveHand, event: unknown): void {
		if (live.disposed) return;
		const type = (event as { type?: unknown }).type;
		if (
			type !== "message_start" &&
			type !== "message_update" &&
			type !== "message_end" &&
			type !== "tool_execution_start" &&
			type !== "tool_execution_end" &&
			type !== "agent_end"
		) {
			return;
		}

		const now = Date.now();
		if (type === "message_start" || type === "message_update" || type === "message_end") {
			const message = (event as { message?: AgentMessage }).message;
			if (message?.role === "assistant") {
				this.trackThinking(live, message as AssistantMessage, type !== "message_end", now);
			}
		}
		if (type === "message_update" && now - live.lastUpdate < 60) return;
		live.lastUpdate = now;
		try {
			if (type === "message_end") this.recordUsage(live);
			refreshTranscript(live.snapshot, live.session, live.thinkingTimes);
		} catch {
			return;
		}
		this.emit({ type: "hands_updated", hand: cloneHand(live.snapshot) });
	}

	private trackThinking(
		live: LiveHand,
		message: AssistantMessage,
		streaming: boolean,
		now: number,
	): void {
		const runs = thinkingRuns(message);
		if (runs.length === 0) return;

		const timings = live.thinkingTimes.get(message.timestamp) ?? [];
		runs.forEach((run, index) => {
			const timing = timings[index] ?? { startedAt: now };
			timings[index] = timing;
			if (!streaming || run.settled) timing.endedAt ??= now;
		});
		live.thinkingTimes.set(message.timestamp, timings);
	}

	private async runTurn(live: LiveHand, message: string, wake = false): Promise<void> {
		if (live.disposed) return;
		if (!wake) this.host.cancelWake?.(live.snapshot.id);
		live.reported = false;
		const hand = live.snapshot;
		hand.status = "running";
		hand.error = undefined;
		hand.result = undefined;
		hand.finishedAt = undefined;
		this.emit({ type: "hands_updated", hand: cloneHand(hand) });

		const turnStart = live.session.agent.state.messages.length;
		const resultParts: string[] = [];

		try {
			let errorMessage: string | undefined;
			for (let attempt = 0; ; attempt++) {
				await live.session.prompt(attempt === 0 ? message : HAND_CONTINUATION_PROMPT);
				if (live.disposed) return;
				const turnMessages = live.session.agent.state.messages.slice(turnStart);
				const error = findHandError(turnMessages);
				if (error) {
					errorMessage = error;
					break;
				}
				const lastAssistant = findLastAssistant(turnMessages);
				const text = lastAssistant ? textFromContent(lastAssistant.content).trim() : "";
				if (text) resultParts.push(text);
				if (lastAssistant?.stopReason !== "length") break;
				if (attempt >= MAX_HAND_CONTINUATIONS) {
					throw new Error("Hand reply hit the output limit before the artifact was complete.");
				}
			}
			if (errorMessage) {
				hand.status = "failed";
				hand.error = sanitizeText(errorMessage);
			} else {
				hand.status = "done";
				hand.result =
					resultParts.length > 0 ? normalizeArtifact(resultParts.join("")) : "Finished.";
			}
		} catch (error) {
			if (live.disposed) return;
			hand.status = "failed";
			hand.error = sanitizeText(error instanceof Error ? error.message : String(error));
		} finally {
			if (!live.disposed) {
				this.recordUsage(live);
				stopRunningTools(hand);
				hand.finishedAt = Date.now();
				try {
					refreshTranscript(hand, live.session, live.thinkingTimes);
				} catch {}
				this.emit({ type: "hands_updated", hand: cloneHand(hand) });
				if (wake && this.host.wake) {
					try {
						// Wake only.
						this.host.wake(formatHandFinished(hand), hand.id);
						live.reported = true;
					} catch {}
				}
			}
		}
	}

	private recordUsage(live: LiveHand): void {
		const messages = live.session.agent.state.messages;
		if (messages.length < live.counted) live.counted = 0;

		for (let index = live.counted; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role !== "assistant" || live.countedMessages.has(message)) continue;

			const usage = (message as AssistantMessage).usage;
			if (!usage) continue;
			if (usage.totalTokens === 0 && usage.cost.total === 0) continue;

			const assistant = message as AssistantMessage;
			live.countedMessages.add(message);
			this.host.recordUsage?.(
				assistant.provider,
				assistant.responseModel ?? assistant.model,
				usage,
			);
		}

		live.counted = messages.length;
	}
}

export type HandsTool = ToolDefinition<typeof HandsParams, HandsDetails> & {
	dispose(): void;
};

export function createHandsTool(host: HandsHost): HandsTool {
	const runtime = new HandsRuntime(host);

	return {
		name: HANDS_TOOL_NAME,
		label: "Hands",
		description: [
			"Hands are role-bound workers, not general chats. Each takes a typed " +
				"input and returns an artifact.",
			`Roles: ${HAND_KIND_HELP}`,
			"Action start: create hands from hands[] with a role and its input; it returns while they work.",
			"Action read: return one hand's complete artifact; optionally pass offset " +
				"or limit to read a window.",
			"Action wait: omit hand to wait for the next finished hand, or pass hand " +
				"to wait for one. Results are complete by default.",
			"Action talk: send one missing fact or continuation. Do not assign a new task.",
			"Action merge: combine completed scout, digger, and critic artifacts into " +
				"one deduped JSON object before reading them one by one.",
			"Action finish: close hands after collecting their results; pass hand to " +
				"close one, or omit it to close all.",
			`You can run up to ${MAX_HANDS} hands at once. ` +
				"Finished hands stay readable until action finish.",
		].join(" "),
		promptSnippet: "hands: typed role workers (scout, digger, runner, critic, builder).",
		promptGuidelines: [
			"Route by role: map -> scout; deep evidence -> digger; run command/tests " +
				"-> runner; verify a specific claim or review a diff -> critic; edit -> " +
				"builder.",
			"For a bug sweep: scout the map, run focused diggers, then start critics " +
				"on the highest-impact or least-certain claims before reporting or " +
				"editing.",
			"Give each digger one subsystem or one question. Split broad target lists " +
				"across hands instead of sampling; a sampled or low-confidence claim is " +
				"not a finding until a critic verifies it.",
			"Fill the typed input slots. Never write a prose brief, never make a hand " +
				"plan, and never ask it to act as coordinator.",
			"Hands start fresh and see only their input. Use parallel hands only for independent work.",
			"Use action note to send a coordinator note while a hand works; it queues " +
				"without waiting. Use talk when you need a reply.",
			'Artifacts are complete by default. Use action "read" with offset or ' +
				'limit only when you explicitly need a window. Use action "talk" only for ' +
				"a missing fact, not to fetch the rest.",
			"After several maps or findings, use action merge instead of deduping the artifacts by hand.",
			"Call finish once when results are collected; it closes the hand " +
				"sessions. Keep the cleanup out of the user-facing reply.",
		],
		parameters: HandsParams,
		async execute(_toolCallId, params, signal) {
			const result = (
				text: string,
				hands: readonly HandSnapshot[] = [],
				isError = false,
				delivered?: Iterable<string>,
				collected?: Iterable<string>,
			) => ({
				content: [{ type: "text" as const, text }],
				details: {
					hands: hands.map(cloneHand),
					...(delivered ? { delivered: [...delivered] } : {}),
					...(collected ? { collected: [...collected] } : {}),
				},
				isError,
			});

			try {
				switch (params.action) {
					case "start": {
						const tasks = (params.hands ?? [])
							.map((hand) => ({
								kind: hand.kind,
								input: hand.input as Record<string, unknown>,
								note: hand.note,
							}))
							.slice(0, MAX_HANDS);
						if (tasks.length === 0) {
							return result("No hand tasks were provided.");
						}
						const hands = await runtime.start(tasks, params.context);
						const overlap = overlapHint(tasks);
						return result(
							`${formatStartedHands(hands)}${overlap ? `\n\n${overlap}` : ""}`,
							hands,
						);
					}

					case "read": {
						const handRef = params.hand?.trim();
						if (!handRef) return result('Read needs a hand title, such as "Hand 1".');
						const window = readWindow(params.offset, params.limit);
						const hand = runtime.read(handRef);
						return result(formatHand(hand, window.offset, window.limit), [hand]);
					}

					case "wait": {
						const handRef = params.hand?.trim();
						const waited = await runtime.wait(handRef, signal);
						return result(
							handRef
								? formatHandsSummary(waited.hands)
								: formatWaitSummary(waited.hands, waited.delivered),
							waited.hands,
							false,
							waited.delivered,
							waited.collected,
						);
					}

					case "note": {
						const handRef = params.hand?.trim();
						const message = params.message?.trim();
						if (!handRef) return result('Note needs a hand title, such as "Hand 1".');
						if (!message) return result("Note needs a message.");
						const hand = await runtime.note(handRef, message);
						return result(`Note queued for ${hand.title}.`, [hand]);
					}

					case "merge": {
						const hands = runtime.snapshots();
						return result(mergeHandArtifacts(hands), hands);
					}

					case "talk": {
						const handRef = params.hand?.trim();
						const message = params.message?.trim();
						if (!handRef) return result('Talk needs a hand title, such as "Hand 1".');
						if (!message) return result("Talk needs a message.");
						const hand = await runtime.talk(handRef, message, signal);
						return result(formatHandsSummary([hand]), [hand]);
					}

					case "finish": {
						const hands = runtime.finish(params.hand);
						return result(`Closed ${hands.map((hand) => hand.title).join(", ")}.`, hands);
					}
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return result(formatHandFailure(reason, handFailureNext(params.action)), [], true);
			}
		},

		dispose(): void {
			runtime.dispose();
		},
	};
}
