import type { ConversationId } from "./types.ts";

export class ReadAfterWrite extends Error {
	constructor(method: string) {
		super(`Tx.${method}() cannot read tables after the first table write`);
		this.name = "ReadAfterWrite";
	}
}

export class StorageRejected extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StorageRejected";
	}
}

export function asStorageRejected(error: unknown): Error {
	if (error instanceof StorageRejected) return error;

	const message = error instanceof Error ? error.message : String(error);
	return new StorageRejected(message, { cause: error });
}

export class ConversationBusy extends Error {
	readonly conversationId: ConversationId;

	constructor(conversationId: ConversationId) {
		super(`Conversation ${conversationId} is busy`);
		this.name = "ConversationBusy";
		this.conversationId = conversationId;
	}
}
