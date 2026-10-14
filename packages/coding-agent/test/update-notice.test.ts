import { Container } from "@huranth/gama-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/tui/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/tui/theme/theme.ts";

function render(container: Container): string {
	const text = container.children.flatMap((child) => child.render(120)).join("\n");
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("update notice", () => {
	beforeAll(() => initTheme("dark"));

	it("shows the classic update card", () => {
		const chatContainer = new Container();
		const context = {
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		};

		(InteractiveMode.prototype as any).showNewVersionNotification.call(context, {
			version: "1.1.4",
		});

		const text = render(chatContainer);

		expect(text).toContain("Update Available");
		expect(text).toContain("New version 1.1.4 is available. Run gama update");
		expect(text).toContain("/changelog");
		expect(text).toContain("to see what changed");
		expect(text).not.toContain("gama.dev");
	});

	it("renders a release note inside the card", () => {
		const chatContainer = new Container();
		const context = {
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		};

		(InteractiveMode.prototype as any).showNewVersionNotification.call(context, {
			version: "1.1.4",
			note: "Fixed the updater.",
		});

		expect(render(chatContainer)).toContain("Fixed the updater.");
	});

	it("marks the card installed once the version matches", () => {
		const chatContainer = new Container();
		const prototype = InteractiveMode.prototype as any;
		const context = {
			availableRelease: { version: "9.9.9" },
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			updateNoticeVersion: "9.9.9",
			updateNoticeCard: undefined,
		};

		prototype.showNewVersionNotification.call(context, { version: "9.9.9" });

		const text = render(chatContainer);
		expect(text).toContain("Update Installed");
		expect(text).toContain("Updated to 9.9.9. Restart gama");
		expect(text).not.toContain("gama update");
	});

	it("prints no startup changelog when it is hidden", () => {
		const chatContainer = new Container();
		const prototype = InteractiveMode.prototype as any;
		const context = {
			startupNoticesShown: false,
			changelogMarkdown: "## 1.2.0\n\n- New thing.",
			settingsManager: { getCollapseChangelog: () => true },
			showWelcome: vi.fn(),
			chatContainer,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		};

		prototype.showStartupNoticesIfNeeded.call(context);

		expect(chatContainer.children).toHaveLength(0);
		expect(context.startupNoticesShown).toBe(true);
	});

	it("prints the startup changelog when it is shown", () => {
		const chatContainer = new Container();
		const prototype = InteractiveMode.prototype as any;
		const context = {
			startupNoticesShown: false,
			changelogMarkdown: "## 1.2.0\n\n- New thing.",
			settingsManager: { getCollapseChangelog: () => false },
			showWelcome: vi.fn(),
			chatContainer,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		};

		prototype.showStartupNoticesIfNeeded.call(context);

		expect(render(chatContainer)).toContain("What's New");
	});

	it("shows release notes for the available update", async () => {
		const chatContainer = new Container();
		const prototype = InteractiveMode.prototype as any;
		const context = {
			availableRelease: { version: "1.1.1", note: "Update notice is a single dim line." },
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			showWarning: vi.fn(),
			showChangelogPanel: prototype.showChangelogPanel,
		};

		await prototype.handleChangelogCommand.call(context);

		const text = render(chatContainer);
		expect(text).toContain("Changelog");
		expect(text).toContain("Update notice is a single dim");
		expect(text.match(/1\.1\.1/g)).toHaveLength(1);
	});
});
