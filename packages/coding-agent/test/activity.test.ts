import type { TUI, TuiMouseEvent } from "@huranth/gama-tui";
import chalk from "chalk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { READ_BEFORE_CHANGE_MESSAGE } from "../src/core/tools/file-read-tracker.ts";
import {
	ActivityLineComponent,
	type ActivityRecord,
	ActivityTickerComponent,
	activityKind,
	activityTargetPath,
	formatActivityLine,
} from "../src/modes/tui/parts/activity.ts";
import { initTheme, theme } from "../src/modes/tui/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function tui(rows = 18): { ui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { ui: { terminal: { rows }, requestRender } as unknown as TUI, requestRender };
}

function record(toolCallId: string, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
	return {
		toolCallId,
		name: "read",
		args: { path: `src/${toolCallId}.ts` },
		status: "running",
		timestamp: Date.now() - 30_000,
		...overrides,
	};
}

function mouse(type: TuiMouseEvent["type"], y: number, x = 1): TuiMouseEvent {
	return { ...click(y, x), type, button: "none" };
}

function click(y: number, x = 1): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 18,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

const plain = (lines: string[]) => lines.map(stripAnsi).join("\n");

describe("ActivityTickerComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("renders one sentence per call as soon as it arrives", () => {
		const { ui } = tui();
		const ticker = new ActivityTickerComponent({ ui });
		ticker.add(record("one", { name: "read", args: { path: "src/main.ts" }, status: "success" }));
		ticker.add(record("two", { name: "bash", args: { command: "npm test" }, status: "pending" }));
		const rows = ticker.render(80);
		expect(rows).toHaveLength(2);
		const text = plain(rows);
		expect(text).toContain("read src/main.ts");
		expect(text).toContain("running npm test");
	});

	it("stays stable after settle; the turn never folds rows away", () => {
		const { ui } = tui();
		const ticker = new ActivityTickerComponent({ ui });
		ticker.add(record("one", { name: "read", args: { path: "a.ts" }, status: "success" }));
		ticker.add(record("two", { name: "edit", args: { path: "c.ts" }, status: "success" }));
		ticker.settle();
		const text = plain(ticker.render(80));
		expect(text).toContain("a.ts");
		expect(text).toContain("c.ts");
		expect(ticker.recordCount).toBe(2);
	});

	it("keeps errors visible after settle", () => {
		const { ui } = tui();
		const ticker = new ActivityTickerComponent({ ui });
		ticker.add(record("one", { name: "bash", args: { command: "x" }, status: "error" }));
		ticker.settle();
		expect(ticker.recordCount).toBe(1);
		expect(plain(ticker.render(80))).toContain("failed to run x");
	});

	it("resets cleanly for the next prompt via reset()", () => {
		const { ui } = tui();
		const ticker = new ActivityTickerComponent({ ui });
		ticker.add(record("one", { status: "success" }));
		ticker.reset();
		expect(ticker.render(80)).toEqual([]);
	});

	it("updates replace records by id and never leak tool arguments", () => {
		const { ui } = tui();
		const ticker = new ActivityTickerComponent({ ui });
		ticker.add(record("one", { args: { path: "a.ts", apiKey: "hidden-secret" } }));
		ticker.update(record("one", { status: "success" }));
		expect(ticker.recordCount).toBe(1);
		expect(plain(ticker.render(80))).not.toContain("hidden-secret");
		ticker.update(record("missing"));
		expect(ticker.recordCount).toBe(1);
	});

	it("stays within any width and hides gracefully at zero", () => {
		const { ui } = tui();
		const ticker = new ActivityTickerComponent({ ui });
		ticker.add(
			record("one", {
				args: { path: "a-very-long-path/that/keeps/going/and going and going.ts" },
			}),
		);
		for (const width of [0, 1, 4, 12, 80]) {
			for (const line of ticker.render(width)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(Math.max(width, 1));
			}
		}
	});
});

describe("activity helpers", () => {
	beforeAll(() => initTheme("dark"));

	it("classifies tools into kinds", () => {
		expect(activityKind("read")).toBe("reading");
		expect(activityKind("grep")).toBe("reading");
		expect(activityKind("webfetch")).toBe("reading");
		expect(activityKind("edit")).toBe("editing");
		expect(activityKind("write")).toBe("editing");
		expect(activityKind("bash")).toBe("running");
		expect(activityKind("powershell")).toBe("running");
		expect(activityKind("other")).toBe("working");
	});

	it("extracts the target path from common argument shapes", () => {
		expect(activityTargetPath(record("x", { args: { path: "a.ts" } }))).toBe("a.ts");
		expect(activityTargetPath(record("x", { args: { file_path: "b.ts" } }))).toBe("b.ts");
		expect(activityTargetPath(record("x", { args: { url: "https://example.com" } }))).toBe(
			"https://example.com",
		);
		expect(activityTargetPath(record("x", { args: { command: "npm test" } }))).toBe("");
		expect(activityTargetPath(record("x", { args: "junk" }))).toBe("");
	});

	it("names the target while running and keeps it after settle", () => {
		const ticker = new ActivityTickerComponent({ ui: tui().ui });
		ticker.add(record("one", { name: "read", args: { path: "src/one.ts" }, status: "success" }));
		ticker.add(record("two", { name: "bash", args: { command: "npm test" }, status: "pending" }));
		ticker.add(
			record("three", { name: "edit", args: { path: "src/three.ts" }, status: "running" }),
		);
		const rows = ticker.render(80);
		const text = plain(rows);
		expect(text).toContain("read src/one.ts");
		expect(text).toContain("running npm test");
		expect(text).toContain("editing src/three.ts");
		expect(rows).toHaveLength(3);
	});
});

describe("ActivityLineComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("formats one plain sentence per tool", () => {
		const read = stripAnsi(
			formatActivityLine(
				record("one", { name: "read", args: { path: "a.ts" }, status: "running" }),
				process.cwd(),
			),
		);
		const bash = stripAnsi(
			formatActivityLine(
				record("two", { name: "bash", args: { command: "x" }, status: "success" }),
				process.cwd(),
			),
		);
		expect(read).toContain("reading a.ts");
		expect(bash).toContain("bash x");
	});

	it("labels a write as create for a new file and edit for an overwrite", () => {
		const created = stripAnsi(
			formatActivityLine(
				record("c", {
					name: "write",
					args: { path: "new.ts" },
					status: "success",
					result: { content: [], details: { created: true } },
				}),
				process.cwd(),
			),
		);
		const overwritten = stripAnsi(
			formatActivityLine(
				record("o", {
					name: "write",
					args: { path: "old.ts" },
					status: "success",
					result: { content: [], details: { created: false } },
				}),
				process.cwd(),
			),
		);
		expect(created).toContain("create new.ts");
		expect(overwritten).toContain("edit old.ts");
		expect(overwritten).not.toContain("create");
	});

	it("labels an edit as edit", () => {
		const edited = stripAnsi(
			formatActivityLine(
				record("e", { name: "edit", args: { path: "a.ts" }, status: "success" }),
				process.cwd(),
			),
		);
		expect(edited).toContain("edit a.ts");
		expect(edited).not.toContain("create");
	});

	it("refreshes in place as the record status changes", () => {
		const rec = record("one", { name: "read", args: { path: "a.ts" }, status: "running" });
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(stripAnsi(line.render(80).join("\n"))).toContain("reading a.ts");
		rec.status = "success";
		rec.result = { content: [{ type: "text", text: "body" }] };
		expect(stripAnsi(line.render(80).join("\n"))).toContain("read a.ts");
	});

	it("keeps one sentence row on a collapsed card", () => {
		const body = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
		const rec = record("one", { name: "read", args: { path: "a.ts" }, status: "success" });
		rec.result = { content: [{ type: "text", text: body }] };
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		const collapsed = line.render(80);
		expect(collapsed).toHaveLength(3);
		expect(plain(collapsed)).toContain("read a.ts");
		expect(plain(collapsed)).toContain("15 lines");
		expect(plain(collapsed)).not.toContain("line 1");
		expect(plain(collapsed)).not.toContain("expand");

		const handled = line.handleMouse(click(0, 2));
		expect(handled?.handled).toBe(true);
		expect(line.isExpanded).toBe(true);
		const expanded = plain(line.render(80));
		expect(expanded).toContain("line 1");
		expect(expanded).toContain("line 15");

		line.handleMouse(click(3, 2));
		expect(line.isExpanded).toBe(false);
		expect(line.render(80)).toHaveLength(3);
	});

	it("keeps short content on one line until expanded", () => {
		const rec = record("one", { name: "read", args: { path: "a.ts" }, status: "success" });
		rec.result = { content: [{ type: "text", text: "line one\nline two" }] };
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		const collapsed = plain(line.render(80));
		expect(collapsed).not.toContain("line one");
		line.setExpanded(true);
		const expanded = plain(line.render(80));
		expect(expanded).toContain("line one");
		expect(expanded).toContain("line two");
	});

	it("shows the written code on an expanded write card, not the result stub", () => {
		const rec = record("w", {
			name: "write",
			args: { path: "a.py", content: "import secrets\nimport string\n" },
			status: "success",
			result: { content: [{ type: "text", text: "Successfully wrote to a.py" }] },
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(plain(line.render(80))).not.toContain("import secrets");
		line.setExpanded(true);
		const expanded = plain(line.render(80));
		expect(expanded).toContain("import secrets");
		expect(expanded).toContain("import string");
		expect(expanded).not.toContain("Successfully wrote");
	});

	it("shows removed and added counts on an edit row and the diff when expanded", () => {
		const diff = "-1 old line\n+1 new line\n 1 context line";
		const rec = record("e", {
			name: "edit",
			args: { path: "a.ts" },
			status: "success",
			result: {
				content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
				details: { diff },
			},
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		const collapsed = plain(line.render(80));
		expect(collapsed).toContain("edit a.ts");
		expect(collapsed).toContain("+1");
		expect(collapsed).toContain("-1");
		expect(collapsed).not.toContain("old line");
		line.setExpanded(true);
		const expanded = plain(line.render(80));
		expect(expanded).toContain("-1 old line");
		expect(expanded).toContain("+1 new line");
		expect(expanded).not.toContain("Successfully replaced");
	});

	it("keeps running bash output out of the row until it is expanded", () => {
		const rec = record("b", {
			name: "bash",
			args: { command: "npm test" },
			status: "running",
			result: { content: [{ type: "text", text: "12 passed\n3,180 tests passed" }] },
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		const collapsed = line.render(80);
		expect(collapsed).toHaveLength(3);
		expect(plain(collapsed)).toContain("running npm test");
		expect(plain(collapsed)).not.toContain("3,180 tests passed");
		line.setExpanded(true);
		const expanded = plain(line.render(80));
		expect(expanded).toContain("12 passed");
		expect(expanded).toContain("3,180 tests passed");
	});

	it("settles a bash row to its command, with the output on expand", () => {
		const rec = record("b", {
			name: "bash",
			args: { command: "npm test" },
			status: "success",
			result: { content: [{ type: "text", text: "12 passed\n0 failed" }] },
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		const collapsed = plain(line.render(80));
		expect(collapsed).toContain("bash npm test");
		expect(collapsed).not.toContain("0 failed");
		line.setExpanded(true);
		expect(plain(line.render(80))).toContain("0 failed");
	});

	it("uses progressive verbs while running and settled verbs when done", () => {
		const running = (name: string, args: unknown) =>
			plain(
				new ActivityLineComponent({
					record: record("x", { name, args, status: "running" }),
					cwd: () => process.cwd(),
				}).render(80),
			);
		expect(running("write", { path: "a.ts", content: "x" })).toContain("writing a.ts");
		expect(running("edit", { path: "a.ts" })).toContain("editing a.ts");
		expect(running("read", { path: "a.ts" })).toContain("reading a.ts");

		const done = (name: string, args: unknown) =>
			plain(
				new ActivityLineComponent({
					record: record("x", { name, args, status: "success", result: { content: [] } }),
					cwd: () => process.cwd(),
				}).render(80),
			);
		expect(done("write", { path: "a.ts", content: "x" })).toContain("write a.ts");
		expect(done("write", { path: "a.ts", content: "x" })).not.toContain("writing");
		expect(done("edit", { path: "a.ts" })).toContain("edit a.ts");
		expect(done("read", { path: "a.ts" })).toContain("read a.ts");
	});

	it("names the target even before the tool has produced anything", () => {
		const rec = record("w", { name: "write", args: { path: "a.ts" }, status: "running" });
		const collapsed = plain(
			new ActivityLineComponent({ record: rec, cwd: () => process.cwd() }).render(80),
		);
		expect(collapsed.trim()).toBe("writing a.ts");
		expect(collapsed).not.toContain("Running...");
		expect(collapsed).not.toContain("Streaming...");
	});

	it("stays off screen until the file path streams in", () => {
		const rec = record("w", {
			name: "write",
			args: { content: "const a = 1;\nconst b = 2;\n" },
			status: "running",
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(line.render(80)).toEqual([]);

		rec.args = { path: "src/a.txt", content: "const a = 1;\nconst b = 2;\n" };
		expect(plain(line.render(80))).toContain("writing src/a.txt");
		expect(plain(line.render(80))).toContain("+2");

		const bare = (name: string) =>
			new ActivityLineComponent({
				record: record("x", { name, args: {}, status: "running" }),
				cwd: () => process.cwd(),
			}).render(80);
		expect(bare("read")).toEqual([]);
		expect(bare("edit")).toEqual([]);
		expect(bare("bash")).toEqual([]);

		const settledUnknown = plain(
			new ActivityLineComponent({
				record: record("x", { name: "todo", args: {}, status: "success" }),
				cwd: () => process.cwd(),
			}).render(80),
		).trim();
		expect(settledUnknown).toBe("todo");
	});

	it("counts written lines as they stream", () => {
		const rec = record("w", {
			name: "write",
			args: { path: "a.ts", content: "const a = 1;\n" },
			status: "running",
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(plain(line.render(80))).toContain("writing a.ts");
		expect(plain(line.render(80))).toContain("+1");
		rec.args = { path: "a.ts", content: "const a = 1;\nconst b = 2;\n" };
		const updated = line.render(80);
		expect(updated).toHaveLength(3);
		expect(plain(updated)).toContain("writing a.ts");
		expect(plain(updated)).toContain("+2");
	});

	it("counts removals as the old text streams, before the new text arrives", () => {
		const rec = record("e", {
			name: "edit",
			args: { path: "a.ts", edits: [{ oldText: "one\ntwo\nthree\n" }] },
			status: "running",
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(plain(line.render(80))).toContain("editing a.ts");
		expect(plain(line.render(80))).toContain("+0");
		expect(plain(line.render(80))).toContain("-3");

		rec.args = {
			path: "a.ts",
			edits: [{ oldText: "one\ntwo\nthree\n", newText: "uno\n" }],
		};
		expect(plain(line.render(80))).toContain("editing a.ts");
		expect(plain(line.render(80))).toContain("+1");
		expect(plain(line.render(80))).toContain("-3");

		rec.args = {
			path: "a.ts",
			edits: [{ oldText: "one\ntwo\nthree\n", newText: "uno\ndos\n" }],
		};
		expect(plain(line.render(80))).toContain("editing a.ts");
		expect(plain(line.render(80))).toContain("+2");
		expect(plain(line.render(80))).toContain("-3");
	});

	it("counts added and removed lines as an edit streams", () => {
		const rec = record("e", {
			name: "edit",
			args: {
				path: "a.ts",
				edits: [
					{
						oldText: "keep\nold line\nkeep two",
						newText: "keep\nnew line\nnew two\nkeep two",
					},
				],
			},
			status: "running",
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(plain(line.render(80))).toContain("editing a.ts");
		expect(plain(line.render(80))).toContain("+2");
		expect(plain(line.render(80))).toContain("-1");

		rec.args = {
			path: "a.ts",
			edits: [{ oldText: "keep\nold line\nkeep two", newText: "keep\nkeep two" }],
		};
		expect(plain(line.render(80))).toContain("editing a.ts");
		expect(plain(line.render(80))).toContain("+0");
		expect(plain(line.render(80))).toContain("-1");
	});

	it("treats a rewrite of an existing file as editing while it runs", () => {
		const rec = record("w", {
			name: "write",
			args: { path: "package.json", content: "{}\n" },
			status: "running",
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(plain(line.render(80))).toContain("editing package.json");
		expect(plain(line.render(80))).toContain("+1");
	});

	it("keeps a fast edit on screen long enough to read", () => {
		vi.useFakeTimers();
		try {
			const rec = record("e", {
				name: "edit",
				args: {
					path: "a.ts",
					edits: [{ oldText: "old", newText: "new one\nnew two" }],
				},
				status: "running",
			});
			const line = new ActivityLineComponent({
				record: rec,
				cwd: () => process.cwd(),
				ui: { requestRender: vi.fn() } as unknown as TUI,
			});
			expect(plain(line.render(80))).toContain("editing a.ts");
			expect(plain(line.render(80))).toContain("+2");
			expect(plain(line.render(80))).toContain("-1");

			rec.status = "success";
			rec.result = { content: [], details: { diff: "-1 old\n+1 new one\n+2 new two" } };
			const during = plain(line.render(80));
			expect(during).toContain("editing a.ts");
			expect(during).not.toContain("edit a.ts");

			vi.advanceTimersByTime(400);
			expect(plain(line.render(80))).toContain("editing a.ts");

			vi.advanceTimersByTime(900);
			expect(plain(line.render(80))).toContain("edit a.ts");
			expect(plain(line.render(80))).toContain("+2");
			expect(plain(line.render(80))).toContain("-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("holds a live call that settled before its first frame", () => {
		vi.useFakeTimers();
		try {
			const rec = record("e", {
				name: "edit",
				args: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
				status: "success",
				result: { content: [], details: { diff: "-1 old\n+1 new" } },
				timestamp: Date.now(),
			});
			const line = new ActivityLineComponent({
				record: rec,
				cwd: () => process.cwd(),
				ui: { requestRender: vi.fn() } as unknown as TUI,
			});
			expect(plain(line.render(80))).toContain("editing a.ts");
			vi.advanceTimersByTime(900);
			expect(plain(line.render(80))).toContain("edit a.ts");
			expect(plain(line.render(80))).toContain("+1");
			expect(plain(line.render(80))).toContain("-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not hold an old settled row", () => {
		const rec = record("e", {
			name: "edit",
			args: { path: "a.ts" },
			status: "success",
			result: { content: [], details: { diff: "-1 old\n+1 new" } },
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		expect(plain(line.render(80))).toContain("edit a.ts");
		expect(plain(line.render(80))).toContain("+1");
		expect(plain(line.render(80))).toContain("-1");
	});

	it("settles at once once the row has been readable", () => {
		vi.useFakeTimers();
		try {
			const rec = record("e", {
				name: "edit",
				args: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
				status: "running",
			});
			const line = new ActivityLineComponent({
				record: rec,
				cwd: () => process.cwd(),
				ui: { requestRender: vi.fn() } as unknown as TUI,
			});
			line.render(80);
			vi.advanceTimersByTime(700);
			rec.status = "success";
			rec.result = { content: [], details: { diff: "-1 old\n+1 new" } };
			expect(plain(line.render(80))).toContain("edit a.ts");
			expect(plain(line.render(80))).toContain("+1");
			expect(plain(line.render(80))).toContain("-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("sweeps a shine across the running word", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const previousLevel = chalk.level;
		chalk.level = 3;
		try {
			const rec = record("one", { name: "read", args: { path: "a.ts" }, status: "running" });
			const line = new ActivityLineComponent({
				record: rec,
				cwd: () => process.cwd(),
				ui: { requestRender: vi.fn() } as unknown as TUI,
			});
			const first = line.render(80)[1] ?? "";
			// Two steps.
			vi.advanceTimersByTime(220);
			const second = line.render(80)[1] ?? "";
			expect(second).not.toBe(first);
			expect(stripAnsi(second)).toBe(stripAnsi(first));
			expect(stripAnsi(second).trim()).toBe("reading a.ts");
		} finally {
			chalk.level = previousLevel;
			vi.useRealTimers();
		}
	});

	it("holds the light on the settled word for a beat and then goes dim", () => {
		vi.useFakeTimers();
		const previousLevel = chalk.level;
		chalk.level = 3;
		try {
			const rec = record("one", { name: "read", args: { path: "a.ts" }, status: "running" });
			const line = new ActivityLineComponent({
				record: rec,
				cwd: () => process.cwd(),
				ui: { requestRender: vi.fn() } as unknown as TUI,
			});
			line.render(80);
			rec.status = "success";
			rec.result = { content: [{ type: "text", text: "body" }] };
			const lit = line.render(80)[1] ?? "";
			vi.advanceTimersByTime(600);
			const dim = line.render(80)[1] ?? "";

			const fresh = new ActivityLineComponent({
				record: { ...rec },
				cwd: () => process.cwd(),
			}).render(80)[1];
			expect(lit).not.toBe(dim);
			expect(dim).toBe(fresh);
			expect(stripAnsi(dim)).toContain("read a.ts");
			expect(stripAnsi(dim)).toContain("1 line");
		} finally {
			chalk.level = previousLevel;
			vi.useRealTimers();
		}
	});

	it("renders a dim sentence inside the card fill", () => {
		const previousLevel = chalk.level;
		chalk.level = 3;
		try {
			const rec = record("w", {
				name: "write",
				args: { path: "index.html", content: "<h1>hi</h1>" },
				status: "success",
				result: { content: [{ type: "text", text: "Successfully wrote to index.html" }] },
			});
			const lines = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() }).render(
				80,
			);
			const rendered = lines.join("\n");
			expect(rendered).not.toContain(theme.getFgAnsi("accent"));
			expect(stripAnsi(rendered)).toContain("write index.html");
			expect(rendered).toContain(theme.getBgAnsi("toolSuccessBg"));
			for (const line of lines) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
			}
		} finally {
			chalk.level = previousLevel;
		}
	});

	it("reports a failed call as a plain proud Error without a glyph", () => {
		const failed = new ActivityLineComponent({
			record: record("f", {
				name: "bash",
				args: { command: "npm test" },
				status: "error",
				result: { content: [{ type: "text", text: "Command exited with code 1" }] },
			}),
			cwd: () => process.cwd(),
		})
			.render(80)
			.join("\n");
		expect(stripAnsi(failed)).toContain("failed to run npm test");
		expect(stripAnsi(failed)).not.toContain("Command exited");
	});

	it("keeps a failed call collapsed on hover and reveals the full message on click", () => {
		const rec = record("f", {
			name: "write",
			args: { path: "a.ts" },
			status: "error",
			result: { content: [{ type: "text", text: READ_BEFORE_CHANGE_MESSAGE }] },
		});
		const line = new ActivityLineComponent({ record: rec, cwd: () => process.cwd() });
		const collapsed = plain(line.render(80));
		expect(collapsed).toContain("failed to write a.ts");
		expect(collapsed).not.toContain("Read before writing");

		line.handleMouse(mouse("move", 0));
		expect(plain(line.render(80))).toBe(collapsed);

		line.handleMouse(mouse("leave", 0));
		expect(plain(line.render(80))).toBe(collapsed);

		line.handleMouse(click(0));
		const expanded = plain(line.render(200));
		expect(expanded).toContain("failed to write a.ts");
		expect(expanded).toContain(READ_BEFORE_CHANGE_MESSAGE);
	});

	it("shows the whole body the moment a running card is expanded", () => {
		const body = Array.from({ length: 10 }, (_, index) => `M${index + 1} ${"x".repeat(90)}`).join(
			"\n",
		);
		const rec = record("w", {
			name: "write",
			args: { path: "a.ts", content: `${body}\n` },
			status: "running",
		});
		const line = new ActivityLineComponent({
			record: rec,
			cwd: () => process.cwd(),
			ui: { requestRender: vi.fn() } as unknown as TUI,
		});
		line.setExpanded(true);
		const expanded = plain(line.render(80));
		expect(expanded).toContain("writing a.ts");
		expect(expanded).toContain("M1");
		expect(expanded).toContain("M10");

		rec.status = "success";
		rec.result = { content: [{ type: "text", text: "ok" }] };
		expect(plain(line.render(80))).toContain("write a.ts");
	});
});
