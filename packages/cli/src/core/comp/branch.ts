import type { AgentMessage, StreamFn, ThinkingLevel } from "@huranth/gama-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@huranth/gama-ai";
import { contentText, normalizeContext } from "@huranth/gama-ai";
import type { Api, Model, SimpleStreamOptions, Usage } from "@huranth/gama-ai/compat";
import { DEFAULT_CONTEXT_WINDOW } from "../custom-provider.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../msg.ts";
import type { ReadonlySessionManager, SessionEntry } from "../sessions.ts";
import {
	completeSummarization,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	getSummarizationFailure,
	SUMMARY_FORMAT,
} from "./compact.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

export type { FileOperations } from "./utils.ts";

const BRANCH_SUMMARY_PREAMBLE =
	`The user explored a different conversation branch ` +
	`before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT =
	`Create a checkpoint of this conversation branch for context ` +
	`when returning later.

Use this exact format. Leave out any section that has nothing to say:

${SUMMARY_FORMAT}

Keep each item to one line. Preserve exact paths, names, commands, and error text.
Do not describe the branch or this summary.`;

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
			);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

export interface BranchSummaryResult {
	summary?: string;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface BranchPreparation {
	messages: AgentMessage[];
	fileOps: FileOperations;
	totalTokens: number;
}

export interface CollectEntriesResult {
	entries: SessionEntry[];
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	signal: AbortSignal;
	customInstructions?: string;
	replaceInstructions?: boolean;
	reserveTokens?: number;
	streamFn?: StreamFn;
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
	sessionId?: string;
	thinkingLevel?: ThinkingLevel;
}

export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	entries.reverse();

	return { entries, commonAncestorId };
}

export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		streamFn,
		retry,
		callbacks,
		sessionId,
		thinkingLevel,
	} = options;

	if (signal.aborted) return { aborted: true };

	const contextWindow = model.contextWindow || DEFAULT_CONTEXT_WINDOW;

	const reserve = Math.max(0, Math.min(reserveTokens, Math.floor(contextWindow * 0.9)));
	const tokenBudget = contextWindow - reserve;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const maxTokens = Math.min(
		1200,
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	const context = normalizeContext({
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: summarizationMessages,
	});
	const requestOptions: SimpleStreamOptions = {
		apiKey,
		headers,
		env,
		signal,
		maxTokens,
		sessionId,
	};

	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		requestOptions.reasoning = thinkingLevel;
	}

	const response = await completeSummarization(
		model,
		context,
		requestOptions,
		streamFn,
		retry,
		callbacks,
	);

	if (response.stopReason === "aborted" || signal.aborted) {
		return { aborted: true };
	}
	const failure = getSummarizationFailure(response, "Branch summarization");
	if (failure) {
		return { error: failure };
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		return { error: "Tool call blocked" };
	}

	// Stale guard
	if (signal.aborted) return { aborted: true };

	const text = contentText(response.content);
	if (text.trim() === "") {
		throw new Error("Empty summary");
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	const filesText = formatFileOperations(readFiles, modifiedFiles);
	const summary = BRANCH_SUMMARY_PREAMBLE + text + filesText;

	return {
		summary,
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}

export function prepareBranchEntries(
	entries: SessionEntry[],
	tokenBudget: number = 0,
): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) {
					fileOps.read.add(f);
				}
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		const tokens = estimateTokens(message);

		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					extractFileOpsFromMessage(message, fileOps);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		extractFileOpsFromMessage(message, fileOps);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}
