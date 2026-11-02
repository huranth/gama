import type { AnyModel } from "./types.ts";

export interface ModelsStoreEntry {
	models: readonly AnyModel[];
	lastModified?: number;
	checkedAt?: number;
	etag?: string;
}

export interface ModelsStoreOperationOptions {
	signal?: AbortSignal;
}

export interface ModelsStore {
	read(
		providerId: string,
		options?: ModelsStoreOperationOptions,
	): Promise<ModelsStoreEntry | undefined>;
	write(
		providerId: string,
		entry: ModelsStoreEntry,
		options?: ModelsStoreOperationOptions,
	): Promise<void>;
	delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}

function checkAbort(options?: ModelsStoreOperationOptions): void {
	options?.signal?.throwIfAborted();
}

export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(
		providerId: string,
		options?: ModelsStoreOperationOptions,
	): Promise<ModelsStoreEntry | undefined> {
		checkAbort(options);

		const entry = this.entries.get(providerId);

		return entry ? structuredClone(entry) : undefined;
	}

	async write(
		providerId: string,
		entry: ModelsStoreEntry,
		options?: ModelsStoreOperationOptions,
	): Promise<void> {
		checkAbort(options);

		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		checkAbort(options);

		this.entries.delete(providerId);
	}
}
