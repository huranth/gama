import type { Context } from "@huranth/chord";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@huranth/gama-ai";
import type { SessionImpl } from "../session/session.ts";
import type {
	ContextEdit,
	ConversationId,
	Cursor,
	EntryId,
	EntryRecord,
	Storage,
} from "../types.ts";
import type { ContextView } from "./types.ts";
import { SCAN_PAGE_SIZE } from "./util.ts";

const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set([
	"aborted",
	"error",
	"deferred",
]);

const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

export type ContextBounds = {
	readonly head: (EntryRecord & { readonly head: EntryId }) | undefined;
	readonly tail: EntryId;
};

export async function readContext(
	session: SessionImpl,
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at?: EntryId,
): Promise<ContextView> {
	const bounds = await session.readOnLine(() =>
		captureContextBounds(storage, conversationId, context, at),
	);
	return deriveContext(storage, conversationId, bounds, context);
}

function selectActive(head: ContextBounds["head"], range: EntryRecord[]): EntryRecord[] {
	return head === undefined ? range : [head, ...range.filter((entry) => entry.head === undefined)];
}

function missingResult(call: ToolCall, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: MISSING_RESULT_TEXT }],
		isError: true,
		details: { reason: "missing_result" },
		timestamp,
	};
}

export async function activeEntries(
	storage: Storage,
	conversationId: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<EntryRecord[]> {
	if (bounds === undefined) return [];
	return selectActive(bounds.head, await scanRange(storage, conversationId, bounds, context));
}

async function scanRange(
	storage: Storage,
	conversationId: ConversationId,
	bounds: ContextBounds,
	context: Context,
): Promise<EntryRecord[]> {
	const head = bounds.head;
	const range: EntryRecord[] = [];
	let cursor: Cursor | undefined;

	do {
		const page = await storage.scanEntries(
			head === undefined
				? { conversationId, maxEntryId: bounds.tail }
				: { conversationId, minEntryId: head.head, maxEntryId: bounds.tail },
			SCAN_PAGE_SIZE,
			cursor,
			context,
		);

		range.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);

	return range.reverse();
}

export async function captureContextBounds(
	storage: Storage,
	conversationId: ConversationId,
	context: Context,
	at?: EntryId,
): Promise<ContextBounds | undefined> {
	let tail: EntryId | undefined;

	if (at === undefined) {
		tail = (await storage.scanEntries({ conversationId }, 1, undefined, context)).items[0]?.id;
		if (tail === undefined) return undefined;
	} else {
		if ((await storage.entry(conversationId, at, context)) === undefined) {
			throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
		}
		tail = at;
	}

	return { head: await storage.findLatestHeadMarker(conversationId, tail, context), tail };
}

export async function deriveContext(
	storage: Storage,
	conversationId: ConversationId,
	bounds: ContextBounds | undefined,
	context: Context,
): Promise<ContextView> {
	if (bounds === undefined) {
		return { head: undefined, entries: [], contributions: [], messages: [] };
	}
	const head = bounds.head;
	const range = await scanRange(storage, conversationId, bounds, context);
	const edits = new Map<EntryId, ContextEdit>();
	for (const entry of range) {
		for (const edit of entry.edits ?? []) {
			edits.set(edit.target, edit);
		}
	}

	const entries = selectActive(head, range);
	const contributions = entries.map((entry): Message[] => {
		const edit = edits.get(entry.id);
		if (edit?.action === "omit") return [];
		const contributed = edit?.action === "replace" ? edit.messages : (entry.model ?? []);
		return contributed.filter(
			(message) =>
				message.role !== "assistant" || !EXCLUDED_STOP_REASONS.has(message.stopReason),
		);
	});
	return { head, entries, contributions, messages: orderToolResults(contributions.flat()) };
}

export function orderToolResults(messages: readonly Message[]): Message[] {
	const ordered: Message[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "toolResult") continue;
		ordered.push(message);
		if (message.role !== "assistant") continue;
		const calls = message.content.filter(
			(content): content is ToolCall => content.type === "toolCall",
		);
		if (calls.length === 0) continue;
		const results = new Map<string, number>();
		for (
			let next = index + 1;
			next < messages.length && messages[next]!.role !== "assistant";
			next++
		) {
			const candidate = messages[next]!;
			if (candidate.role === "toolResult" && !results.has(candidate.toolCallId)) {
				results.set(candidate.toolCallId, next);
			}
		}
		for (const call of calls) {
			const resultIndex = results.get(call.id);
			ordered.push(
				resultIndex === undefined
					? missingResult(call, message.timestamp)
					: messages[resultIndex]!,
			);
		}
	}
	return ordered;
}
