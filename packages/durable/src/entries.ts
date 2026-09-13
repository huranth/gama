import type { JsonValue } from "@huranth/chord";
import type { CompactionReason, ToolDiagnostic } from "./harness/types.ts";
import type { Entry, EntryRecord, TypedEntry } from "./types.ts";

export function defineEntry<D extends JsonValue = never>(kind: string): Entry<D> {
	if (typeof kind !== "string" || kind.length === 0) {
		throw new TypeError("Entry kind must be a non-empty string");
	}
	return {
		kind,
		is: (entry: EntryRecord | undefined): entry is TypedEntry<D> =>
			entry !== undefined && entry.kind === kind,
	};
}

export const UserEntry = defineEntry("gama.user");

export const AssistantEntry = defineEntry("gama.assistant");

export const SystemEntry = defineEntry("gama.system");

export const ToolResultEntry = defineEntry<{ diagnostics: ToolDiagnostic[] }>("gama.tool-result");

export const ResetEntry = defineEntry("gama.reset");

export const CompactionEntry = defineEntry<{ reason: CompactionReason }>("gama.compaction");
