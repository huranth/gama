import { Container } from "@huranth/gama-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.ts")>();
	return {
		...actual,
		getSelfUpdateCommand: () => ({
			command: "npm",
			args: ["install", "-g", "@huranth/gama-harness@9.9.9"],
			display: "npm install -g @huranth/gama-harness@9.9.9",
		}),
	};
});

vi.mock("cross-spawn", () => ({
	spawn: vi.fn(() => {
		const { EventEmitter } = require("node:events");
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		setImmediate(() => {
			child.stdout.emit("data", "added 1 package\n");
			child.emit("close", 0);
		});
		return child;
	}),
}));

import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/tui/theme/theme.ts";

function render(container: Container): string {
	const text = container.children.flatMap((child) => child.render(120)).join("\n");
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("update install", () => {
	beforeAll(() => initTheme("dark"));

	it("streams the install output into the chat", async () => {
		const chatContainer = new Container();
		const context = {
			availableRelease: { version: "9.9.9" },
			updateInProgress: false,
			updateNoticeVersion: undefined,
			updateNoticeCard: undefined,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			showWarning: vi.fn(),
		};

		await (InteractiveMode.prototype as any).installRelease.call(context, {
			version: "9.9.9",
		});

		const text = render(chatContainer);

		expect(text).toContain("Updating gama");
		expect(text).toContain("-> 9.9.9");
		expect(text).toContain("npm install -g @huranth/gama-harness@9.9.9");
		expect(text).toContain("added 1 package");
		expect(context.availableRelease).toBeUndefined();
		expect(context.updateNoticeVersion).toBe("9.9.9");
		expect(context.updateInProgress).toBe(false);
	});

	it("reports a failed install and keeps the update available", async () => {
		const { spawn } = await import("cross-spawn");
		vi.mocked(spawn).mockImplementationOnce(() => {
			const { EventEmitter } = require("node:events");
			const child = new EventEmitter() as any;
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			setImmediate(() => child.emit("close", 2));
			return child;
		});

		const chatContainer = new Container();
		const context = {
			availableRelease: { version: "9.9.9" },
			updateInProgress: false,
			updateNoticeVersion: undefined,
			updateNoticeCard: undefined,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			showWarning: vi.fn(),
		};

		const ok = await (InteractiveMode.prototype as any).installRelease.call(context, {
			version: "9.9.9",
		});

		expect(ok).toBe(false);
		expect(render(chatContainer)).toContain("Update failed (exit 2)");
		expect(context.updateInProgress).toBe(false);
		expect(context.availableRelease).toEqual({ version: "9.9.9" });
		expect(context.updateNoticeVersion).toBeUndefined();
	});

	it("ignores a second install while one is running", async () => {
		const { spawn } = await import("cross-spawn");
		const calls = vi.mocked(spawn).mock.calls.length;
		const chatContainer = new Container();
		const context = {
			availableRelease: { version: "9.9.9" },
			updateInProgress: true,
			updateNoticeVersion: undefined,
			updateNoticeCard: undefined,
			chatContainer,
			ui: { requestRender: vi.fn() },
		};

		const ok = await (InteractiveMode.prototype as any).installRelease.call(context, {
			version: "9.9.9",
		});

		expect(ok).toBe(false);
		expect(vi.mocked(spawn).mock.calls.length).toBe(calls);
		expect(chatContainer.children).toHaveLength(0);
	});
});
