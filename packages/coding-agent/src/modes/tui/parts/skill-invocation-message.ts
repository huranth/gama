import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@huranth/gama-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

export class SkillInvocationMessageComponent extends Box {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(0, 0);
		this.skillBlock = skillBlock;
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
		const label = theme.fg("muted", theme.bold("[skill]"));
		const name = theme.fg("customMessageText", this.skillBlock.name);
		const header = `${label} ${name}`;

		content.addChild(new Text(header, 0, 0));
		if (this.expanded) {
			content.addChild(new Spacer(1));
			content.addChild(
				new Markdown(this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;

				this.setExpanded(!this.expanded);

				return { handled: true };
			}),
		);
	}
}
