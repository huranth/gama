import {
	type Color,
	Container,
	colorToOklch,
	Markdown,
	type MarkdownTheme,
	parseColor,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@huranth/gama-tui";
import type { MarkdownTransformer } from "../../../core/ext/types.ts";
import { getMarkdownTheme, type ThemeStyle, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const PROMPT_PAD_ROWS = 2;
const PROMPT_INK_ON_LIGHT = "#16210f";
const PROMPT_INK_ON_DARK = "#e8f6e0";

export const PROMPT_SUMMARY_MIN_WORDS = 100;

export interface PromptSummaryConfig {
	enabled: boolean;
	initialText?: string;
	generate: (signal?: AbortSignal) => Promise<string>;
	requestRender?: () => void;
}

type PromptSummaryState = "idle" | "loading" | "ready" | "error";

interface PromptCache {
	width: number;
	lines: string[];
}

interface SummaryCache extends PromptCache {
	state: PromptSummaryState;
	text: string;
	error: string;
}

function padTo(line: string, width: number): string {
	const clipped = truncateToWidth(line, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function promptInk(): Color {
	const { l } = colorToOklch(theme.colors.promptBg);
	return parseColor(l > 0.6 ? PROMPT_INK_ON_LIGHT : PROMPT_INK_ON_DARK);
}

function wordCount(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;

	if (typeof Intl.Segmenter === "function") {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
		let count = 0;
		for (const segment of segmenter.segment(trimmed)) {
			if (segment.isWordLike) count++;
		}
		return count;
	}

	return trimmed.split(/\s+/).length;
}

export class UserMessageComponent extends Container {
	private text: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private summary?: PromptSummaryConfig;
	private summaryText = "";
	private summaryState: PromptSummaryState = "idle";
	private summaryError = "";
	private summaryAbort?: AbortController;
	private summaryRun = 0;
	private canvasOpen = false;
	private buttonRow = -1;
	private canvasTop = -1;
	private canvasBottom = -1;
	private promptCache?: PromptCache;
	private summaryCache?: SummaryCache;

	constructor(
		text: string,
		_markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	override invalidate(): void {
		this.promptCache = undefined;
		this.summaryCache = undefined;
		super.invalidate();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setPromptSummary(config: PromptSummaryConfig | undefined): void {
		this.summaryAbort?.abort();
		this.summaryAbort = undefined;
		this.summaryRun++;
		this.summary = config;
		this.summaryText = config?.initialText ?? "";
		this.summaryState = config?.initialText ? "ready" : "idle";
		this.summaryError = "";
		this.canvasOpen = false;
		this.rebuild();
	}

	private get summaryEligible(): boolean {
		return Boolean(this.summary?.enabled) && wordCount(this.text) > PROMPT_SUMMARY_MIN_WORDS;
	}

	private rebuild(): void {
		this.promptCache = undefined;
		this.summaryCache = undefined;
	}

	private ink(text: string, attributes: ThemeStyle = {}): string {
		return theme.style(text, { fg: promptInk(), ...attributes });
	}

	private promptMarkdownTheme(): MarkdownTheme {
		return {
			heading: (text) => this.ink(text, { bold: true }),
			link: (text) => theme.style(text, { fg: promptInk(), underline: true }),
			linkUrl: (text) => this.ink(text),
			code: (text) => this.ink(text),
			codeBlock: (text) => this.ink(text),
			codeBlockBorder: (text) => this.ink(text),
			quote: (text) => this.ink(text),
			quoteBorder: (text) => this.ink(text),
			hr: (text) => this.ink(text),
			listBullet: (text) => this.ink(text),
			bold: (text) => theme.bold(text),
			italic: (text) => theme.italic(text),
			underline: (text) => theme.underline(text),
			strikethrough: (text) => theme.strikethrough(text),
			highlightCode: (code) => code.split("\n").map((line) => this.ink(line)),
		};
	}

	private band(line: string, width: number): string {
		// Keep background.
		return padTo(line, width)
			.split("\x1b[0m")
			.map((segment) => theme.bg("promptBg", segment))
			.join("\x1b[0m");
	}

	private renderPromptLines(width: number): string[] {
		if (this.promptCache?.width === width) return this.promptCache.lines;

		const lines = new Markdown(
			this.text,
			this.outputPad,
			0,
			this.promptMarkdownTheme(),
			{
				color: (content: string) => this.ink(content),
			},
			{
				preserveOrderedListMarkers: true,
				preserveBackslashEscapes: true,
				transform: createMarkdownTransform("user", false, this.markdownTransformers),
			},
		).render(width);

		this.promptCache = { width, lines };
		return lines;
	}

	private buttonLabel(): string {
		if (this.summaryState === "loading") return "Generating…";
		if (this.summaryState === "ready" || this.summaryState === "error") {
			if (this.canvasOpen) return "Hide";
			return this.summaryText ? "Show" : "Retry";
		}

		return "Generate";
	}

	private renderButtonLine(width: number): string {
		const label = this.buttonLabel();
		const line = this.ink(label, { bold: true });
		const left = " ".repeat(Math.max(0, width - visibleWidth(label) - 1));
		return this.band(left + line, width);
	}

	private buildSummaryLines(width: number): string[] {
		const indent = " ".repeat(this.outputPad);
		const clip = (line: string) =>
			indent + truncateToWidth(line, Math.max(0, width - this.outputPad), "…");

		switch (this.summaryState) {
			case "loading":
				return [clip(this.ink("Writing summary…", { dim: true }))];

			case "error": {
				const detail = (this.summaryError.split("\n")[0] ?? "").trim();
				return [
					clip(this.ink("Summary failed", { bold: true })),
					clip(this.ink(detail || "click Retry to try again", { dim: true })),
				];
			}

			case "ready":
				return new Markdown(this.summaryText, this.outputPad, 0, this.promptMarkdownTheme(), {
					color: (content: string) => this.ink(content),
				}).render(width);

			default:
				return [];
		}
	}

	private renderSummaryLines(width: number): string[] {
		const cached = this.summaryCache;
		if (
			cached?.width === width &&
			cached.state === this.summaryState &&
			cached.text === this.summaryText &&
			cached.error === this.summaryError
		) {
			return cached.lines;
		}

		const lines = this.buildSummaryLines(width);
		this.summaryCache = {
			width,
			state: this.summaryState,
			text: this.summaryText,
			error: this.summaryError,
			lines,
		};
		return lines;
	}

	private async generateSummary(): Promise<void> {
		if (
			!this.summaryEligible ||
			this.summaryState === "loading" ||
			this.summaryState === "ready"
		) {
			return;
		}

		const run = ++this.summaryRun;
		const controller = new AbortController();
		this.summaryAbort = controller;
		this.summaryState = "loading";
		this.summaryError = "";
		this.canvasOpen = true;
		this.requestRender();

		try {
			const text = (await this.summary!.generate(controller.signal)).trim();
			if (run !== this.summaryRun) return;
			if (!text) throw new Error("The model returned an empty summary");
			this.summaryText = text;
			this.summaryState = "ready";
		} catch (error) {
			if (run !== this.summaryRun) return;
			this.summaryState = "error";
			this.summaryError = error instanceof Error ? error.message : String(error);
			this.canvasOpen = true;
		} finally {
			if (this.summaryAbort === controller) this.summaryAbort = undefined;
		}

		this.requestRender();
	}

	private activateButton(): void {
		if (this.summaryState === "loading") return;

		if (this.summaryState === "ready" || (this.summaryState === "error" && this.summaryText)) {
			this.canvasOpen = !this.canvasOpen;
			this.requestRender();
			return;
		}

		void this.generateSummary();
	}

	private requestRender(): void {
		if (this.summary?.requestRender) this.summary.requestRender();
		else this.invalidate();
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (this.summaryEligible) {
			const target = {
				component: this,
				originX: 0,
				originY: 0,
				width: event.width,
				height: event.height,
			};
			const labelWidth = visibleWidth(this.buttonLabel());
			const onButton = event.y === this.buttonRow && event.x >= event.width - labelWidth - 1;

			if (
				onButton &&
				event.type === "click" &&
				event.button === "left" &&
				event.clickCount === 1
			) {
				this.activateButton();
				return { handled: true, target };
			}

			if (
				this.canvasOpen &&
				event.type === "click" &&
				event.button === "left" &&
				(event.clickCount ?? 1) >= 2 &&
				event.y >= this.canvasTop &&
				event.y < this.canvasBottom
			) {
				this.canvasOpen = false;
				this.requestRender();
				return { handled: true, target };
			}
		}

		return super.handleMouse(event);
	}

	override render(width: number): string[] {
		const padding = Array.from({ length: PROMPT_PAD_ROWS }, () => this.band("", width));
		const body = this.renderPromptLines(width).map((line) => this.band(line, width));
		const lines = [...padding, ...body, this.band("", width)];

		this.buttonRow = -1;
		if (this.summaryEligible) {
			this.buttonRow = lines.length;
			lines.push(this.renderButtonLine(width));
		} else {
			lines.push(this.band("", width));
		}

		if (this.summaryEligible && this.canvasOpen) {
			const summaryLines = this.renderSummaryLines(width).map((line) => this.band(line, width));
			this.canvasTop = lines.length;
			lines.push(" ".repeat(width));
			lines.push(this.band("", width));
			lines.push(...summaryLines);
			lines.push(this.band("", width));
			this.canvasBottom = lines.length;
		} else {
			this.canvasTop = -1;
			this.canvasBottom = -1;
		}

		if (lines.length === 0) return lines;
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
