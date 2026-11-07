import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Text,
} from "@huranth/gama-tui";
import type { CompactionSummaryMessage } from "../../core/msg.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

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
			const body = `Compacted ${tokenCount} tokens\n\n${this.message.summary}`;

			return new Markdown(body, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			});
		}

		return new Text(theme.fg("customMessageText", `Compacted ${tokenCount} tokens`), 0, 0);
	}
}
