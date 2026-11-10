import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Text } from "@huranth/gama-tui";
import type { BranchSummaryMessage } from "../../core/msg.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

export class BranchSummaryMessageComponent extends Box {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
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
		if (this.expanded) {
			return new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			});
		}

		return new Text(theme.fg("customMessageText", "Branch summary"), 0, 0);
	}
}
