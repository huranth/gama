import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@huranth/gama-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const content = new Container();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);

		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(this.createBody());

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;

				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}

	private createBody(): Text | Markdown {
		const tokensBefore =
			typeof this.message.tokensBefore === "number" ? this.message.tokensBefore : 0;
		const tokenCount = tokensBefore.toLocaleString();

		if (this.expanded) {
			const header = `**Compacted from ${tokenCount} tokens**\n\n`;

			return new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			});
		}

		const expandHint = theme.fg("dim", keyText("app.tools.expand"));
		const collapsed =
			theme.fg("customMessageText", `Compacted from ${tokenCount} tokens (`) +
			expandHint +
			theme.fg("customMessageText", " to expand)");

		return new Text(collapsed, 0, 0);
	}
}
