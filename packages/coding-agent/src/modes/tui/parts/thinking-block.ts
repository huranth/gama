import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@huranth/gama-tui";
import type { MarkdownTransformer } from "../../../core/ext/types.ts";
import { theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const CHIP_BG = "userMessageBg";

export interface ThinkingBlockOptions {
	text: string;
	expanded: boolean;
	streaming: boolean;
	startedAt?: number;
	endedAt?: number;
	label: string;
	outputPad: number;
	markdownTheme: MarkdownTheme;
	markdownTransformers: readonly MarkdownTransformer[];
}

function elapsedSeconds(options: ThinkingBlockOptions): number | undefined {
	if (options.startedAt === undefined) return undefined;

	const endedAt = options.endedAt ?? (options.streaming ? Date.now() : undefined);
	if (endedAt === undefined) return undefined;

	return Math.max(1, Math.ceil((endedAt - options.startedAt) / 1000));
}

function thinkingLabel(options: ThinkingBlockOptions): string {
	const seconds = elapsedSeconds(options);
	const verb = options.streaming ? options.label : "Thought";
	const tone = options.streaming ? "accent" : "muted";
	const duration = seconds === undefined ? "" : theme.fg("dim", ` ${seconds}s`);

	return theme.bg(CHIP_BG, ` ${theme.fg(tone, verb)}${duration} `);
}

class ThinkingHeader extends Text {
	private readonly build: () => string;

	constructor(build: () => string, paddingX: number) {
		super("", paddingX, 0);
		this.build = build;
	}

	override render(width: number): string[] {
		this.setText(this.build());
		return super.render(width);
	}
}

export class ThinkingBlockComponent extends Container {
	constructor(options: ThinkingBlockOptions) {
		super();

		this.addChild(new ThinkingHeader(() => thinkingLabel(options), options.outputPad));

		if (!options.expanded) return;

		this.addChild(new Spacer(1));
		this.addChild(
			new Markdown(
				options.text,
				options.outputPad + 2,
				0,
				options.markdownTheme,
				{
					color: (content: string) => theme.fg("thinkingText", content),
					italic: true,
				},
				{
					transform: createMarkdownTransform(
						"assistant-thinking",
						options.streaming,
						options.markdownTransformers,
					),
				},
			),
		);
	}
}
