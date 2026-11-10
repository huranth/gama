import type { AgentMessage, StreamFn, ThinkingLevel } from "@huranth/gama-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	getSystemMessageText,
	normalizeContext,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	uuidv7,
} from "@huranth/gama-ai";
import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	TranscriptContext,
	Usage,
} from "@huranth/gama-ai/compat";
import { completeSimple } from "@huranth/gama-ai/compat";
import { convertToLlm } from "../msg.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionProjection,
	sessionEntryToContextMessages,
} from "../sessions.ts";
import { combineUsage } from "../usage.ts";
import { buildCompactionMemory } from "./memory.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

const CHARS_PER_TOKEN = 4;

const MIN_SUMMARY_TOKENS = 1024;

const MAX_SUMMARY_TOKENS = 2000;

const MAX_RESERVE_RATIO = 0.9;

const ESTIMATED_IMAGE_CHARS = 4800;

const MAX_MEMORY_CHARS = 6000;

const MIN_MEMORY_CHARS = 1200;

const MEMORY_RESERVE_RATIO = 0.75;

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter?: number;
	usage?: Usage;
	details?: T;
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

export interface CutPointResult {
	firstKeptEntryIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

export interface SummarizationLineage {
	messages: AgentMessage[];
	tools?: Parameters<typeof normalizeContext>[0]["tools"];
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOperations;
	settings: CompactionSettings;
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

function getMessagesFromProjectedEntryForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
	if (entry.sourceEntry.type === "compaction") return [];
	return entry.messages.filter((message) => message.role !== "system");
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

function memoryBudget(reserveTokens: number): number {
	const scaled = Math.floor(reserveTokens * MEMORY_RESERVE_RATIO);
	return Math.min(MAX_MEMORY_CHARS, Math.max(MIN_MEMORY_CHARS, scaled));
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

function getLastAssistantUsageInfo(
	messages: AgentMessage[],
): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		const estimated = estimateMessagesTokens(messages);
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}

		const usageEntryIndex = usageEntryId
			? branchEntries.findIndex((entry) => entry.id === usageEntryId)
			: -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type === "context_edit" || entry.type === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}

	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function clampReserveTokens(configured: number, contextWindow: number): number {
	const wanted = Math.max(0, configured);
	return Math.min(wanted, Math.floor(contextWindow * MAX_RESERVE_RATIO));
}

export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
): boolean {
	if (!settings.enabled) return false;
	if (contextWindow <= 0) return false;
	const reserve = clampReserveTokens(settings.reserveTokens, contextWindow);
	return contextTokens > contextWindow - reserve;
}

function estimateTextAndImageContentChars(
	content: string | Array<{ type: string; text?: string }>,
): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "system": {
			const system = message as SystemMessage;
			chars = estimateTextAndImageContentChars(system.content);
			if (system.sections) {
				for (const section of Object.values(system.sections)) {
					if (section) chars += section.length;
				}
			}
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / CHARS_PER_TOKEN);
		}
	}

	return 0;
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

function collectCutPoints<T>(
	entries: T[],
	startIndex: number,
	endIndex: number,
	isSkipped: (entry: T) => boolean,
	hasCutPoint: (entry: T) => boolean,
): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (isSkipped(entry)) continue;
		if (hasCutPoint(entry)) cutPoints.push(i);
	}
	return cutPoints;
}

function scanBackForCutIndex<T>(
	entries: T[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
	cutPoints: number[],
	tokensAt: (entry: T) => number,
): { cutIndex: number; exceededBudget: boolean } {
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const messageTokens = tokensAt(entries[i]);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			const nextCut = cutPoints.find((candidate) => candidate >= i);
			cutIndex = nextCut ?? cutPoints[cutPoints.length - 1];
			return { cutIndex, exceededBudget: true };
		}
	}
	return { cutIndex, exceededBudget: false };
}

function trimEmptyPrefix<T>(
	entries: T[],
	cutIndex: number,
	startIndex: number,
	isStopping: (entry: T) => boolean,
): number {
	while (cutIndex > startIndex) {
		if (isStopping(entries[cutIndex - 1])) break;
		cutIndex--;
	}
	return cutIndex;
}

function findTurnStart<T>(
	entries: T[],
	entryIndex: number,
	startIndex: number,
	isStart: (entry: T) => boolean,
): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isStart(entries[i])) return i;
	}
	return -1;
}

function findValidCutPoints(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
): number[] {
	return collectCutPoints(
		entries,
		startIndex,
		endIndex,
		(entry) => entry.type === "compaction",
		(entry) => sessionEntryToContextMessages(entry).some(isCutPointMessage),
	);
}

export function findTurnStartIndex(
	entries: SessionEntry[],
	entryIndex: number,
	startIndex: number,
): number {
	return findTurnStart(entries, entryIndex, startIndex, isTurnStartEntry);
}

export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	const scan = scanBackForCutIndex(
		entries,
		startIndex,
		endIndex,
		keepRecentTokens,
		cutPoints,
		(entry) => estimateMessagesTokens(sessionEntryToContextMessages(entry)),
	);
	const cutIndex = trimEmptyPrefix(
		entries,
		scan.cutIndex,
		startIndex,
		(entry) => entry.type === "compaction" || sessionEntryToContextMessages(entry).length > 0,
	);

	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

export const SUMMARY_FORMAT = `## Goal
[What the user wants, in one or two sentences. Keep their wording where it defines scope.]

## Now
- Done: [finished work]
- Active: [work in progress]
- Next: [the next concrete action]

## Rules
- [User constraints or preferences that still apply]

## Decisions
- [What was decided and why]

## Open
- [Unanswered questions, blockers, or unfinished requests, in the user's words]

## Verified
- [Command or check and its result. Say what has not been run yet.]`;

const CHECKPOINT_RULES = `Checkpoint rules:
- One line per item, 20 words or less. No nested lists, no code blocks, no file contents.
- Preserve exact paths, names, commands, numbers, and error text.
- Write only what the next agent cannot recover by reading the files or running the code.
- Do not describe the conversation, this checkpoint, or that context was compacted.
- Newer information wins. Drop anything the work has moved past.
- An exact appendix (requests, file excerpts, commands, answers) is added after your checkpoint.
  Do not repeat it; add meaning, not inventory.
- Aim for 400 tokens. Stop at 800.`;

const SUMMARIZATION_PROMPT =
	`The messages above are a conversation to summarize.
Write a handoff checkpoint that another agent will read instead ` +
	`of this history when it resumes the work.

Use this exact format. Leave out any section that has nothing to say:

${SUMMARY_FORMAT}

${CHECKPOINT_RULES}`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Rewrite the existing checkpoint as one current state.
Rules:
- Merge the new messages into the existing sections.
- Move finished work into Done and drop stale or resolved items.
- Keep unresolved requests and their exact wording.
- Newer information wins over older information.

Use this exact format. Leave out any section that has nothing to say:

${SUMMARY_FORMAT}

${CHECKPOINT_RULES}`;

const UPDATE_SUMMARIZATION_PROMPT =
	`The messages above are new conversation since the checkpoint in ` +
	`<previous-summary>.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

export function getSummarizationFailure(
	response: AssistantMessage,
	label: string,
): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	if (response.stopReason === "aborted") {
		return `${label} was aborted`;
	}
	return undefined;
}

function createSummarizationOptions(
	model: Model<Api>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers, env, sessionId };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

export async function completeSummarization(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
	};
	// Abort guard
	requestOptions.signal?.throwIfAborted();
	const produce = async (): Promise<AssistantMessage> =>
		streamFn
			? (await streamFn(model, context, requestOptions)).result()
			: completeSimple(model, context, requestOptions);
	const response = await retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
	requestOptions.signal?.throwIfAborted();
	return response;
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	lineage?: SummarizationLineage,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
			lineage,
		)
	).text;
}

function buildSummarizationContext(promptText: string): TranscriptContext {
	return normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	});
}

export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	lineage?: SummarizationLineage,
): Promise<{ text: string; usage: Usage }> {
	signal?.throwIfAborted();
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const reserve = clampReserveTokens(reserveTokens, contextWindow);
	const budget = Math.max(MIN_SUMMARY_TOKENS, Math.floor(0.8 * reserve));
	const maxTokens = Math.min(
		budget,
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		MAX_SUMMARY_TOKENS,
	);

	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	const lineageMessages = lineage ? convertToLlm(lineage.messages) : undefined;
	let promptText = "";
	if (!lineageMessages) {
		const conversationText = serializeConversation(convertToLlm(currentMessages));
		promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	}
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const completionOptions = createSummarizationOptions(
		model,
		maxTokens,
		apiKey,
		headers,
		env,
		signal,
		thinkingLevel,
		sessionId,
	);
	if (lineage) completionOptions.cacheRetention = "short";

	const systemHead = lineageMessages?.[0]?.role === "system" ? lineageMessages[0] : undefined;
	const context = lineageMessages
		? normalizeContext({
				...(systemHead ? { systemPrompt: getSystemMessageText(systemHead) } : {}),
				...(lineage?.tools ? { tools: lineage.tools } : {}),
				messages: [
					...(systemHead ? lineageMessages.slice(1) : lineageMessages),
					{
						role: "user",
						content: [{ type: "text", text: promptText }],
						timestamp: Date.now(),
					},
				],
			})
		: buildSummarizationContext(promptText);

	const response = await completeSummarization(
		model,
		context,
		completionOptions,
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summary used tool");
	}

	const textContent = contentText(response.content);
	if (textContent.trim() === "") {
		throw new Error("Empty summary");
	}

	return { text: textContent, usage: response.usage };
}

function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
	if (entry.sourceEntry.type === "compaction") return false;
	return entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(
	entries: ProjectedSessionEntry[],
	entryIndex: number,
	startIndex: number,
): number {
	return findTurnStart(entries, entryIndex, startIndex, isProjectedTurnStart);
}

function findProjectedCutPoint(
	entries: ProjectedSessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = collectCutPoints(
		entries,
		startIndex,
		endIndex,
		(entry) => entry.sourceEntry.type === "compaction",
		(entry) => entry.messages.some(isCutPointMessage),
	);
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	const scan = scanBackForCutIndex(
		entries,
		startIndex,
		endIndex,
		keepRecentTokens,
		cutPoints,
		(entry) => estimateMessagesTokens(entry.messages),
	);
	const exceededBudget = scan.exceededBudget;
	let cutIndex = scan.cutIndex;

	const suffix = entries.slice(cutIndex + 1, endIndex);
	const isIntrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
		entry.sourceEntry.type !== "context_edit" &&
		sessionEntryToContextMessages(entry.sourceEntry).length > 0;
	const isOmitted = (entry: ProjectedSessionEntry): boolean =>
		isIntrinsicallyVisible(entry) && entry.messages.length === 0;
	const omittedSuffixIds = new Set(suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id));
	const hasExternalReplacement = suffix.some(
		(entry) =>
			entry.sourceEntry.type === "context_edit" &&
			entry.sourceEntry.replacement !== null &&
			!omittedSuffixIds.has(entry.sourceEntry.targetId),
	);
	const isRecoveryOmissionSuffix =
		exceededBudget &&
		!hasExternalReplacement &&
		suffix.some(
			(entry) =>
				entry.sourceEntry.type === "message" &&
				entry.sourceEntry.message.role === "assistant" &&
				isOmitted(entry),
		) &&
		suffix.every(
			(entry) =>
				entry.sourceEntry.type !== "compaction" &&
				(!isIntrinsicallyVisible(entry) || isOmitted(entry)),
		);
	if (isRecoveryOmissionSuffix) cutIndex++;

	cutIndex = trimEmptyPrefix(
		entries,
		cutIndex,
		startIndex,
		(entry) => entry.sourceEntry.type === "compaction" || entry.messages.length > 0,
	);
	const startsTurn = isProjectedTurnStart(entries[cutIndex]);
	const turnStartIndex = startsTurn
		? -1
		: findProjectedTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	const projection = buildSessionProjection(pathEntries);
	const projectedEntries = projection.entries;
	const sourceEntries = projectedEntries.map((entry) => entry.sourceEntry);
	const prevCompactionIndex = projectedEntries.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		previousSummary = (projectedEntries[prevCompactionIndex].sourceEntry as CompactionEntry)
			.summary;
		boundaryStart = prevCompactionIndex + 1;
	}
	const boundaryEnd = projectedEntries.length;
	const tokensBefore = estimateProjectedContextTokens(projection, pathEntries).tokens;
	const cutPoint = findProjectedCutPoint(
		projectedEntries,
		boundaryStart,
		boundaryEnd,
		settings.keepRecentTokens,
	);

	const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
	if (!firstKeptEntry?.id) return undefined;
	const firstKeptEntryId = firstKeptEntry.id;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize = projectedEntries
		.slice(boundaryStart, historyEnd)
		.flatMap(getMessagesFromProjectedEntryForCompaction);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? projectedEntries
				.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
				.flatMap(getMessagesFromProjectedEntryForCompaction)
		: [];

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	const fileOps = extractFileOperations(messagesToSummarize, sourceEntries, prevCompactionIndex);

	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

const TURN_PREFIX_SUMMARIZATION_PROMPT =
	"The messages above are earlier context from an ongoing conversation. Later messages " +
	`are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This ` +
	`checkpoint will be placed before the later messages so the conversation can continue ` +
	`with the necessary context.

Return 2 to 5 bullets, one line each, with no headings:
- What the user asked for
- Decisions and work completed
- Facts needed to understand the later messages

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

export async function compact(
	preparation: CompactionPreparation,
	model: Model<Api>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
	lineage?: SummarizationLineage,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = previousSummary ?? "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId,
				lineage,
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
		}
		// Cancel guard
		signal?.throwIfAborted();
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
			sessionId,
		);
		summary = `${historyText}\n\n## Earlier In This Turn\n\n${turnPrefixResult.text}`;
		summaryUsage = historyUsage
			? combineUsage(historyUsage, turnPrefixResult.usage)
			: turnPrefixResult.usage;
	} else {
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
			lineage,
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += buildCompactionMemory({
		messages: isSplitTurn ? [...messagesToSummarize, ...turnPrefixMessages] : messagesToSummarize,
		fileOps,
		maxChars: memoryBudget(settings.reserveTokens),
	});

	if (!firstKeptEntryId) {
		throw new Error("Entry missing UUID");
	}

	// Abort guard
	signal?.throwIfAborted();

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	signal?.throwIfAborted();
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const reserve = clampReserveTokens(reserveTokens, contextWindow);
	const budget = Math.max(MIN_SUMMARY_TOKENS, Math.floor(0.5 * reserve));
	const maxTokens = Math.min(
		budget,
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		MAX_SUMMARY_TOKENS,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = [
		"# Conversation",
		conversationText,
		"",
		"# Instructions",
		TURN_PREFIX_SUMMARIZATION_PROMPT,
	].join("\n");

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		createSummarizationOptions(
			model,
			maxTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			sessionId,
		),
		streamFn,
		retry,
		callbacks,
	);

	const failure = getSummarizationFailure(response, "Turn prefix summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summary used tool");
	}

	const text = contentText(response.content).trim();
	if (!text) {
		throw new Error("Empty summary");
	}

	return { text, usage: response.usage };
}
