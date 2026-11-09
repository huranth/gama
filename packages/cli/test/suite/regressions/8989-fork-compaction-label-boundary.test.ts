import { describe, expect, it } from "vitest";
import { type CompactionEntry, SessionStore } from "../../../src/core/sessions.ts";
import { userMsg } from "../../test-helpers.ts";

describe("regression #8989", () => {
	it("preserves compaction context when a fork removes the boundary label", () => {
		const session = SessionStore.inMemory();
		const oldId = session.appendMessage(userMsg("old"));
		const labelId = session.appendLabelChange(oldId, "checkpoint");
		const keptId = session.appendMessage(userMsg("kept"));
		const compactionId = session.appendCompaction("summary", labelId, 100);
		const leafId = session.appendMessage(userMsg("after"));

		session.createBranchedSession(leafId);

		expect((session.getEntry(compactionId) as CompactionEntry).firstKeptEntryId).toBe(keptId);
		expect(session.buildSessionContext().messages).toMatchObject([
			{ role: "compactionSummary", summary: "summary" },
			{ role: "user", content: "kept" },
			{ role: "user", content: "after" },
		]);
	});
});
