import { estimateProjectedContextTokens } from "./comp/index.ts";
import type { SessionBoundaryDraft } from "./ext/index.ts";
import { type SessionEntry, SessionManager } from "./session-manager.ts";

function appendDraft(manager: SessionManager, draft: SessionBoundaryDraft): string {
	switch (draft.type) {
		case "custom":
			return manager.appendCustomEntry(draft.customType, draft.data);
		case "custom_message":
			return manager.appendCustomMessageEntry(
				draft.customType,
				draft.content,
				draft.display,
				draft.details,
			);
		case "context_edit":
			return manager.appendContextEdit(draft.targetId, draft.replacement);
		case "compaction": {
			const projection = manager.buildSessionProjection();
			const tokensBefore = estimateProjectedContextTokens(
				projection,
				manager.getBranch(),
			).tokens;
			return manager.appendCompaction(
				draft.summary,
				draft.firstKeptEntryId,
				tokensBefore,
				draft.details,
				true,
				draft.usage,
			);
		}
	}
}

export function applyBoundaryDrafts(
	manager: SessionManager,
	drafts: SessionBoundaryDraft[],
): SessionEntry[] {
	const appended: SessionEntry[] = [];
	for (const draft of drafts) {
		const entry = manager.getEntry(appendDraft(manager, draft));
		if (entry) appended.push(entry);
	}
	return appended;
}

export function createBoundaryPreviewManager(
	sessionManager: SessionManager,
	cwd: string,
	drafts: SessionBoundaryDraft[],
): SessionManager {
	const header = sessionManager.getHeader();
	if (!header) throw new Error("Session header is missing");

	const branch = sessionManager.getBranch();
	const manager = SessionManager.inMemory(cwd, undefined, [header, ...branch]);
	applyBoundaryDrafts(manager, drafts);
	return manager;
}
