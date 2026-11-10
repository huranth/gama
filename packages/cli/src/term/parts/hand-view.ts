import type { AssistantMessage } from "@huranth/gama-ai";
import {
	type Component,
	Container,
	type MarkdownTheme,
	Spacer,
	Text,
	type TUI,
} from "@huranth/gama-tui";
import type { MarkdownTransformer } from "../../core/ext/types.ts";
import { formatHandFailure, HAND_RUN_NEXT } from "../../core/hand-failure.ts";
import type { HandSnapshot, HandToolItem, HandTranscriptItem } from "../../core/hands.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { ActivityLineComponent, type ActivityRecord } from "./activity.ts";
import { AssistantMessageComponent, hasVisibleAssistantContent } from "./assistant-message.ts";
import { UserMessageComponent } from "./user-message.ts";

export interface HandViewOptions {
	cwd?: () => string;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	requestRender?: () => void;
	toolOutputExpanded?: boolean;
	onToggleThinking?: () => void;
}

interface Block {
	tool: boolean;
	components: Component[];
}

export class HandViewComponent extends Container {
	private snapshot: HandSnapshot;
	private readonly markdownTheme: MarkdownTheme;
	private readonly outputPad: number;
	private readonly markdownTransformers: readonly MarkdownTransformer[];
	private readonly cwd: () => string;
	private hiddenThinkingLabel: string;
	private toolOutputExpanded: boolean;
	private readonly requestRender?: () => void;
	private readonly onToggleThinking?: () => void;
	private readonly components = new Map<string, Component>();
	private thinkingExpanded: boolean;
	private readonly assistantState = new Map<
		string,
		{
			message: unknown;
			streaming: boolean;
			blocks: number;
			chars: number;
			thinking?: { startedAt: number; endedAt?: number }[];
		}
	>();

	constructor(
		snapshot: HandSnapshot,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		options: HandViewOptions = {},
	) {
		super();
		this.snapshot = snapshot;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.cwd = options.cwd ?? (() => process.cwd());
		this.hiddenThinkingLabel = options.hiddenThinkingLabel ?? "Thinking";
		this.requestRender = options.requestRender;
		this.onToggleThinking = options.onToggleThinking;
		this.thinkingExpanded = !(options.hideThinkingBlock ?? false);
		this.toolOutputExpanded = options.toolOutputExpanded ?? false;
		this.updateDisplay();
	}

	setHideThinkingBlock(hide: boolean): void {
		this.thinkingExpanded = !hide;
		for (const component of this.components.values()) {
			if (component instanceof AssistantMessageComponent) component.setHideThinkingBlock(hide);
		}
		this.requestRender?.();
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		for (const component of this.components.values()) {
			if (component instanceof AssistantMessageComponent)
				component.setHiddenThinkingLabel(label);
		}
	}

	setToolOutputExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const component of this.components.values()) {
			if (component instanceof ActivityLineComponent) component.setExpanded(expanded);
		}
		this.requestRender?.();
	}

	setSnapshot(snapshot: HandSnapshot): void {
		this.snapshot = snapshot;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		const items = this.items();
		const active = new Set<string>();
		const blocks: Block[] = [];

		for (const item of items) {
			if (item.role === "assistant" && !hasVisibleAssistantContent(item.message)) continue;

			const key = this.keyOf(item);
			active.add(key);
			const component = this.componentOf(item, key);

			if (item.role === "tool") {
				const last = blocks.at(-1);
				if (last?.tool) last.components.push(component);
				else blocks.push({ tool: true, components: [component] });
				continue;
			}

			blocks.push({ tool: false, components: [component] });
		}

		for (const [key, component] of this.components) {
			if (active.has(key)) continue;
			this.disposeComponent(component);
			this.components.delete(key);
		}

		this.clear();

		const content = new Container();
		for (const [index, block] of blocks.entries()) {
			if (index > 0) content.addChild(new Spacer(1));
			for (const component of block.components) content.addChild(component);
		}

		if (
			(this.snapshot.status === "failed" || this.snapshot.status === "cancelled") &&
			this.snapshot.error
		) {
			content.addChild(new Spacer(1));
			const error =
				this.snapshot.status === "failed"
					? formatHandFailure(this.snapshot.error, HAND_RUN_NEXT)
					: this.snapshot.error;
			content.addChild(new Text(theme.fg("error", error), this.outputPad, 0));
		}

		this.addChild(content);
	}

	private items(): HandTranscriptItem[] {
		const items: HandTranscriptItem[] = [...this.snapshot.transcript];
		if (!items.some((item) => item.role === "user")) {
			items.unshift({ role: "user", id: "task", text: this.snapshot.task });
		}
		return items;
	}

	private keyOf(item: HandTranscriptItem): string {
		return item.id;
	}

	private componentOf(item: HandTranscriptItem, key: string): Component {
		const cached = this.components.get(key);
		if (cached) {
			if (item.role === "assistant" && cached instanceof AssistantMessageComponent) {
				const state = this.assistantState.get(key);
				const message = item.message;
				const chars = contentChars(message);
				if (
					!state ||
					state.message !== message ||
					state.streaming !== (item.streaming === true) ||
					state.blocks !== message.content.length ||
					state.chars !== chars ||
					state.thinking !== item.thinking
				) {
					cached.updateContent(message, item.streaming === true, item.thinking);
					this.assistantState.set(key, {
						message,
						streaming: item.streaming === true,
						blocks: message.content.length,
						chars,
						thinking: item.thinking,
					});
				}
			} else if (item.role === "tool" && cached instanceof ActivityLineComponent) {
				cached.setRecord(this.toolRecord(item));
			}
			return cached;
		}

		let component: Component;

		if (item.role === "user") {
			component = new UserMessageComponent(
				item.text,
				this.markdownTheme,
				this.outputPad,
				this.markdownTransformers,
			);
		} else if (item.role === "tool") {
			const line = new ActivityLineComponent({
				record: this.toolRecord(item),
				cwd: this.cwd,
				ui: this.requestRender ? ({ requestRender: this.requestRender } as TUI) : undefined,
			});
			line.setExpanded(this.toolOutputExpanded);
			component = line;
		} else {
			const assistant = new AssistantMessageComponent(
				undefined,
				!this.thinkingExpanded,
				this.markdownTheme,
				this.hiddenThinkingLabel,
				this.outputPad,
				this.markdownTransformers,
				() => this.requestRender?.(),
				() => (this.onToggleThinking ?? (() => this.toggleThinking()))(),
			);
			assistant.updateContent(item.message, item.streaming === true, item.thinking);
			this.assistantState.set(key, {
				message: item.message,
				streaming: item.streaming === true,
				blocks: item.message.content.length,
				chars: contentChars(item.message),
				thinking: item.thinking,
			});
			component = assistant;
		}

		this.components.set(key, component);
		return component;
	}

	private toggleThinking(): void {
		this.thinkingExpanded = !this.thinkingExpanded;
		for (const component of this.components.values()) {
			if (component instanceof AssistantMessageComponent) {
				component.setHideThinkingBlock(!this.thinkingExpanded);
			}
		}
		this.requestRender?.();
	}

	private toolRecord(item: HandToolItem): ActivityRecord {
		return {
			toolCallId: item.toolCallId,
			name: item.name,
			args: item.args,
			status: item.status,
			result: item.result,
			timestamp: item.timestamp ?? 0,
		};
	}

	dispose(): void {
		this.disposeComponents();
	}

	private disposeComponents(): void {
		for (const component of this.components.values()) this.disposeComponent(component);
		this.components.clear();
		this.assistantState.clear();
	}

	private disposeComponent(component: Component): void {
		const disposable = component as Component & { dispose?: () => void };
		disposable.dispose?.();
	}
}

function contentChars(message: AssistantMessage): number {
	return message.content.reduce(
		(sum, block) =>
			sum +
			(block.type === "text"
				? block.text.length
				: block.type === "thinking"
					? block.thinking.length
					: 0),
		0,
	);
}
