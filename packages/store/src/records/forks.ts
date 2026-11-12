import type { Context } from "@huranth/gama-bus";
import { addressId } from "../docs.ts";
import { SCAN_PAGE_SIZE } from "../engine/util.ts";
import type {
	ConversationId,
	Cursor,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentPoint,
	DocumentRecord,
	EntryId,
	Storage,
} from "../types.ts";

type ForkPolicy = "asOf" | "current";

export type ForkDocumentCopy = {
	readonly record: DocumentCreate;
	readonly source: DocumentCopySource;
};

export async function prepareForkDocumentCopies(
	storage: Storage,
	parentConversationId: ConversationId,
	at: EntryId,
	childConversationId: ConversationId,
	context: Context,
): Promise<readonly ForkDocumentCopy[]> {
	const entry = await storage.entry(parentConversationId, at, context);
	if (entry === undefined) {
		throw new Error(`Hidden entry: ${at}`);
	}

	const copies: ForkDocumentCopy[] = [];
	const copiedAddresses = new Set<string>();
	await collectCopies({
		storage,
		scope: { kind: "conversation", conversationId: entry.entry.conversationId },
		at: entry.commitSeq,
		policy: "asOf",
		childConversationId,
		copies,
		copiedAddresses,
		context,
	});
	await collectCopies({
		storage,
		scope: { kind: "conversation", conversationId: parentConversationId },
		at: "current",
		policy: "current",
		childConversationId,
		copies,
		copiedAddresses,
		context,
	});
	return copies;
}

interface CollectCopiesInput {
	storage: Storage;
	scope: Extract<DocumentRecord["scope"], { readonly kind: "conversation" }>;
	at: DocumentPoint;
	policy: ForkPolicy;
	childConversationId: ConversationId;
	copies: ForkDocumentCopy[];
	copiedAddresses: Set<string>;
	context: Context;
}

async function collectCopies(input: CollectCopiesInput): Promise<void> {
	const { storage, scope, at, policy, childConversationId, copies, copiedAddresses, context } =
		input;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanDocuments({ scope, at }, SCAN_PAGE_SIZE, cursor, context);
		for (const source of page.items) {
			if (source.scope.kind !== "conversation" || source.fork !== policy) continue;
			const id = await storage.mintId<DocumentId>();
			const identity = {
				id,
				kind: source.kind,
				...(source.key === undefined ? {} : { key: source.key }),
				scope: { kind: "conversation" as const, conversationId: childConversationId },
			};
			const record: DocumentCreate =
				source.history === "latest"
					? { ...identity, history: "latest", fork: source.fork }
					: { ...identity, history: "rewindable", fork: source.fork };
			const copyAddress = addressId(record);
			if (copiedAddresses.has(copyAddress)) {
				const member = record.key === undefined ? record.kind : `${record.kind}/${record.key}`;
				throw new Error(`Multiple documents: ${member}`);
			}
			copiedAddresses.add(copyAddress);
			copies.push({ record, source: { id: source.id, at } });
		}
		cursor = page.next;
	} while (cursor !== undefined);
}
