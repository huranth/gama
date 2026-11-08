import { visibleWidth } from "@huranth/gama-tui";
import { describe, expect, it } from "vitest";
import { ActivityLineComponent, type ActivityRecord } from "../src/term/parts/activity.ts";
import { initTheme } from "../src/term/theme/theme.ts";

const WIDTH = 80;

function fetchRecord(status: "running" | "success"): ActivityRecord {
	return {
		toolCallId: "fetch-1",
		name: "fetch",
		status,
		timestamp: Date.now(),
		args: { url: "https://example.com" },
		...(status === "success"
			? {
					result: {
						content: [
							{
								type: "text",
								text: "some fetched text\n\n[Content truncated — next offset 1959]",
							},
						],
					},
				}
			: {}),
	};
}

describe("activity card reveal", () => {
	it("hides the body and keeps full width while the tool runs", () => {
		initTheme("dark");
		const component = new ActivityLineComponent({ record: fetchRecord("running") });
		component.setExpanded(true);

		const lines = component.render(WIDTH);

		expect(lines.some((line) => line.includes("Content truncated"))).toBe(false);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(WIDTH);
		}
	});

	it("reveals the settled body at the same width without underlining the fill", () => {
		initTheme("dark");
		const component = new ActivityLineComponent({ record: fetchRecord("success") });
		component.setExpanded(true);

		const lines = component.render(WIDTH);
		const notice = lines.find((line) => line.includes("Content truncated")) ?? "";

		expect(notice).toContain("[Content truncated — next offset 1959]");
		expect(notice).not.toContain("\x1b[4m");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(WIDTH);
		}
	});
});
