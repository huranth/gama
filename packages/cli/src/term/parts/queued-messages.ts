import {
	type Color,
	Container,
	padLine,
	parseColor,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@huranth/gama-tui";
import { ANSI_RESET, theme } from "../theme/theme.ts";

const CARD_MAX_WIDTH = 96;

const CARD_PAD_X = 1;

const HEADING_ROWS = 3;

const BULLET = "• ";

const CARD_BG = parseColor("#80a9d0");

const CARD_HEADING_BG = parseColor("#6e99c4");

const CARD_INK = parseColor("#101b26");

function stripTrailingSpaces(line: string): string {
	return line.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
}

export class QueuedMessagesComponent extends Container {
	private messages: string[] = [];
	private expanded = false;
	private readonly requestRender: () => void;
	private bodyCache?: { width: number; messages: string; lines: string[] };

	constructor(requestRender: () => void) {
		super();
		this.requestRender = requestRender;
	}

	setMessages(messages: string[]): void {
		const next = [...messages];
		if (next.join("\u0000") === this.messages.join("\u0000")) return;

		this.messages = next;
		this.bodyCache = undefined;
	}

	override invalidate(): void {
		this.bodyCache = undefined;
		super.invalidate();
	}

	private buttonLabel(): string {
		return this.expanded ? "Hide" : "Show";
	}

	private paint(line: string, bg: Color): string {
		return line
			.split(ANSI_RESET)
			.map((segment) => theme.style(segment, { bg }))
			.join("");
	}

	private metrics(width: number): {
		margin: number;
		headingWidth: number;
		buttonWidth: number;
		messageWidth: number;
	} {
		const safeWidth = Math.max(1, width);
		const margin = Math.min(1, Math.max(0, safeWidth - 4));
		const available = Math.max(1, safeWidth - margin * 2);
		const buttonWidth = Math.min(available, visibleWidth(this.buttonLabel()) + CARD_PAD_X * 2);
		const messageWidth = Math.min(available, CARD_MAX_WIDTH);

		return {
			margin,
			headingWidth: this.expanded ? messageWidth : buttonWidth,
			buttonWidth,
			messageWidth,
		};
	}

	private place(
		line: string,
		width: number,
		cardWidth: number,
		margin: number,
		bg: Color,
	): string {
		const clipped = truncateToWidth(stripTrailingSpaces(line), cardWidth, "");
		const padded = padLine(clipped, cardWidth);
		const right = " ".repeat(Math.max(0, width - margin - cardWidth));

		return " ".repeat(margin) + this.paint(padded, bg) + right;
	}

	private row(content: string, cardWidth: number): string {
		const innerWidth = Math.max(0, cardWidth - CARD_PAD_X * 2);
		const clipped = truncateToWidth(stripTrailingSpaces(content), innerWidth, "");

		return `${" ".repeat(CARD_PAD_X)}${padLine(clipped, innerWidth)}${" ".repeat(CARD_PAD_X)}`;
	}

	private messageLines(width: number): string[] {
		const cached = this.bodyCache;
		const key = this.messages.join("\u0000");

		if (cached?.width === width && cached.messages === key) return cached.lines;

		const lines = this.messages.flatMap((message) =>
			wrapTextWithAnsi(`${BULLET}${message.replace(/\s+/g, " ").trim()}`, width).map((line) =>
				theme.style(line, { fg: CARD_INK }),
			),
		);

		this.bodyCache = { width, messages: key, lines };

		return lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type === "click" && event.button === "left") {
			const { margin, headingWidth } = this.metrics(event.width);

			if (
				event.y >= 0 &&
				event.y < HEADING_ROWS &&
				event.x >= margin &&
				event.x < margin + headingWidth
			) {
				this.expanded = !this.expanded;
				this.invalidate();
				this.requestRender();

				return {
					handled: true,
					target: {
						component: this,
						originX: 0,
						originY: 0,
						width: event.width,
						height: event.height,
					},
				};
			}
		}

		return super.handleMouse(event);
	}

	override render(width: number): string[] {
		const { margin, headingWidth, messageWidth } = this.metrics(width);
		const lines: string[] = [];
		const place = (line: string, cardWidth: number, bg: Color) => {
			lines.push(this.place(line, width, cardWidth, margin, bg));
		};

		place(this.row("", headingWidth), headingWidth, CARD_HEADING_BG);
		place(
			this.row(theme.style(this.buttonLabel(), { fg: CARD_INK, bold: true }), headingWidth),
			headingWidth,
			CARD_HEADING_BG,
		);
		place(this.row("", headingWidth), headingWidth, CARD_HEADING_BG);

		if (this.expanded) {
			const innerWidth = Math.max(1, messageWidth - CARD_PAD_X * 2);
			const messages = this.messageLines(innerWidth);

			place(this.row("", messageWidth), messageWidth, CARD_BG);

			messages.forEach((line, index) => {
				place(this.row(line, messageWidth), messageWidth, CARD_BG);
				if (index < messages.length - 1) {
					place(this.row("", messageWidth), messageWidth, CARD_BG);
				}
			});

			place(this.row("", messageWidth), messageWidth, CARD_BG);
		}

		return lines;
	}
}
