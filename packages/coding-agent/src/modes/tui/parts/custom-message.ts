import type { TextContent } from "@huranth/gama-ai";
import type { Component } from "@huranth/gama-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@huranth/gama-tui";
import type { MessageRenderer } from "../../../core/ext/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private expanded = false;
	private outputPad: number;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}

		this.expanded = expanded;
		this.rebuild();
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}

		this.removeChild(this.box);

		const custom = this.renderCustom();
		if (custom) {
			this.customComponent = custom;
			this.addChild(custom);
			return;
		}

		this.renderDefault();
	}

	private renderCustom(): Component | undefined {
		if (!this.customRenderer) return undefined;

		try {
			return this.customRenderer(
				this.message,
				{ expanded: this.expanded, outputPad: this.outputPad },
				theme,
			);
		} catch {
			return undefined;
		}
	}

	private renderDefault(): void {
		this.addChild(this.box);
		this.box.clear();

		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);

		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));
		this.box.addChild(
			new Markdown(this.plainText(), 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}

	private plainText(): string {
		const content = this.message.content;

		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";

		return content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
}
