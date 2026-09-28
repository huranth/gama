import type { AssistantMessage } from "@huranth/gama-ai";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@huranth/gama-tui";
import type { MarkdownTransformer } from "../../../core/ext/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { ThinkingBlockComponent } from "./thinking-block.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

const OSC133_ZONE_END = "\x1b]133;B\x07";

const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private readonly thinkingTimings = new Map<number, { startedAt: number; endedAt?: number }>();
	private readonly requestRender?: () => void;
	private readonly onToggleThinkingVisibility?: () => void;
	private thinkingTimer?: ReturnType<typeof setInterval>;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		requestRender?: () => void,
		onToggleThinkingVisibility?: () => void,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.requestRender = requestRender;
		this.onToggleThinkingVisibility = onToggleThinkingVisibility;
		this.contentContainer = new Container();

		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();

		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	dispose(): void {
		this.clearThinkingTimer();
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;

		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;

		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;

		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		if (this.hasToolCalls) return lines;

		if (lines.length === 1) {
			lines[0] = OSC133_ZONE_START + lines[0] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];

		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		this.contentContainer.clear();

		let thinkingRunIndex = 0;

		for (let index = 0; index < message.content.length; index++) {
			const content = message.content[index]!;

			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(this.createTextBlock(content.text.trim()));
				continue;
			}

			if (content.type !== "thinking") continue;

			const thinkingBlocks: string[] = [];

			while (index < message.content.length) {
				const candidate = message.content[index]!;
				if (candidate.type !== "thinking") break;

				const thinking = candidate.thinking.trim();
				if (thinking) thinkingBlocks.push(thinking);

				index++;
			}

			index--;

			if (thinkingBlocks.length === 0) continue;

			const hasVisibleContentAfter = message.content
				.slice(index + 1)
				.some(
					(block) =>
						(block.type === "text" && block.text.trim()) ||
						(block.type === "thinking" && block.thinking.trim()),
				);

			const runIndex = thinkingRunIndex++;
			const hidden = this.hideThinkingBlock;
			const hasFollowingContent = message.content
				.slice(index + 1)
				.some(
					(block) => (block.type === "text" && block.text.trim()) || block.type === "toolCall",
				);
			const thinkingLive = isStreaming && !hasFollowingContent;
			let timing = this.thinkingTimings.get(runIndex);

			if (isStreaming && !timing) {
				timing = { startedAt: Date.now() };
				this.thinkingTimings.set(runIndex, timing);
			}
			if (timing && !thinkingLive && timing.endedAt === undefined) {
				timing.endedAt = Date.now();
			}

			const component = new ThinkingBlockComponent({
				text: thinkingBlocks.join("\n\n"),
				expanded: !hidden,
				streaming: thinkingLive,
				startedAt: timing?.startedAt,
				endedAt: timing?.endedAt,
				label: this.hiddenThinkingLabel,
				outputPad: this.outputPad,
				markdownTheme: this.markdownTheme,
				markdownTransformers: this.markdownTransformers,
			});

			this.contentContainer.addChild(
				new MouseRegion(component, (event) => {
					if (event.type !== "click" || event.button !== "left") return undefined;

					if (this.onToggleThinkingVisibility) {
						this.onToggleThinkingVisibility();
					} else {
						this.hideThinkingBlock = !this.hideThinkingBlock;
						if (this.lastMessage) this.updateContent(this.lastMessage);
					}

					return { handled: true };
				}),
			);

			if (hasVisibleContentAfter) {
				this.contentContainer.addChild(new Spacer(1));
			}
		}

		for (const runIndex of this.thinkingTimings.keys()) {
			if (runIndex >= thinkingRunIndex) this.thinkingTimings.delete(runIndex);
		}

		const hasToolCalls = message.content.some((block) => block.type === "toolCall");
		this.hasToolCalls = hasToolCalls;

		this.appendStopReason(message, hasToolCalls);
		this.syncThinkingTimer();
	}

	private createTextBlock(text: string): Markdown {
		return new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
			transform: createMarkdownTransform(
				"assistant",
				this.isStreaming,
				this.markdownTransformers,
			),
		});
	}

	private syncThinkingTimer(): void {
		const live =
			this.isStreaming &&
			[...this.thinkingTimings.values()].some((timing) => timing.endedAt === undefined);

		if (live && this.requestRender && !this.thinkingTimer) {
			this.thinkingTimer = setInterval(() => this.requestRender?.(), 1000);
			this.thinkingTimer.unref?.();
			return;
		}

		if (!live) this.clearThinkingTimer();
	}

	private clearThinkingTimer(): void {
		if (!this.thinkingTimer) return;
		clearInterval(this.thinkingTimer);
		this.thinkingTimer = undefined;
	}

	private appendStopReason(message: AssistantMessage, hasToolCalls: boolean): void {
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg("error", "Response was truncated before completion"),
					this.outputPad,
					0,
				),
			);
			return;
		}

		if (hasToolCalls) return;

		if (message.stopReason === "aborted") {
			const isDefault = !message.errorMessage || message.errorMessage === "Request was aborted";
			const abortMessage = isDefault ? "Aborted" : (message.errorMessage ?? "Aborted");

			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", abortMessage), this.outputPad, 0),
			);
			return;
		}

		if (message.stopReason !== "error") return;

		const errorMessage = message.errorMessage || "Unknown error";

		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(theme.fg("error", `Error: ${errorMessage}`), this.outputPad, 0),
		);
	}
}
