import type { Box, TuiMouseEvent } from "@huranth/gama-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BranchSummaryMessageComponent } from "../src/term/parts/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/term/parts/compaction-summary-message.ts";
import { SkillInvocationMessageComponent } from "../src/term/parts/skill-invocation-message.ts";
import { initTheme } from "../src/term/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 80;

function renderText(component: Box): string {
	return stripAnsi(component.render(WIDTH).join("\n"));
}

function clickRow(component: Box, marker: string): void {
	const lines = component.render(WIDTH);
	const row = lines.findIndex((line) => stripAnsi(line).includes(marker));
	expect(row).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: WIDTH,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse(event)?.handled).toBe(true);
}

describe("collapsible message components", () => {
	beforeAll(() => initTheme("dark"));

	test("toggles a compaction summary when clicked", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "compaction details",
			tokensBefore: 1234,
			timestamp: Date.now(),
		});

		const collapsed = renderText(component);
		expect(collapsed).not.toContain("compaction details");
		expect(collapsed).toContain("Compacted 1,234 tokens");
		expect(collapsed).not.toContain("[compaction]");
		expect(collapsed).not.toContain("to expand");
		clickRow(component, "Compacted 1,234 tokens");
		expect(renderText(component)).toContain("compaction details");
		clickRow(component, "Compacted 1,234 tokens");
		expect(renderText(component)).not.toContain("compaction details");
	});

	test("keeps the compaction card background across the full row", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "compaction details",
			tokensBefore: 1234,
			timestamp: Date.now(),
		});

		const line = component
			.render(WIDTH)
			.find((row) => stripAnsi(row).includes("Compacted 1,234 tokens"));

		expect(line).toBeDefined();
		expect(line).toContain("\x1b[0m\x1b[48;");
	});

	test("renders compaction summary Markdown without raw markers", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "## Goal\n\n- Done: mapped.\n\n```ts\nconst x = 1;\n```",
			tokensBefore: 1234,
			timestamp: Date.now(),
		});

		clickRow(component, "Compacted 1,234 tokens");
		const text = renderText(component);

		expect(text).toContain("Goal");
		expect(text).toContain("• Done: mapped.");
		expect(text).toContain("const x = 1;");
		expect(text).not.toContain("## Goal");
		expect(text).not.toContain("- Done:");
		expect(text).not.toContain("```");
	});

	test("toggles a branch summary when clicked", () => {
		const component = new BranchSummaryMessageComponent({
			role: "branchSummary",
			summary: "branch details",
			fromId: "entry-1",
			timestamp: Date.now(),
		});

		const collapsed = renderText(component);
		expect(collapsed).not.toContain("branch details");
		expect(collapsed).toContain("Branch summary");
		expect(collapsed).not.toContain("[branch]");
		expect(collapsed).not.toContain("to expand");
		clickRow(component, "Branch summary");
		expect(renderText(component)).toContain("branch details");
		clickRow(component, "branch details");
		expect(renderText(component)).not.toContain("branch details");
	});

	test("toggles a skill invocation when clicked", () => {
		const component = new SkillInvocationMessageComponent({
			name: "example-skill",
			location: "/tmp/example-skill.md",
			content: "skill details",
			userMessage: undefined,
		});

		expect(renderText(component)).not.toContain("skill details");
		clickRow(component, "[skill]");
		expect(renderText(component)).toContain("skill details");
		clickRow(component, "[skill]");
		expect(renderText(component)).not.toContain("skill details");
	});
});
