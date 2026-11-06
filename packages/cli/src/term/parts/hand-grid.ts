import { Container, padLine, type TuiMouseEvent } from "@huranth/gama-tui";
import { HandCardComponent } from "./hand-card.ts";

const SLOT_WIDTH = 30;

const CARD_HEIGHT = 5;

const ROW_GAP = 1;

type HandMouseResult = NonNullable<ReturnType<Container["handleMouse"]>>;

export class HandGridComponent extends Container {
	private readonly cards: HandCardComponent[] = [];
	private hoveredCard: HandCardComponent | undefined;

	addCard(card: HandCardComponent): void {
		this.cards.push(card);
		this.addChild(card);
	}

	override render(width: number): string[] {
		const slotWidth = this.slotWidth(width);
		const columns = this.columns(width, slotWidth);
		const lines: string[] = [];

		for (let start = 0; start < this.cards.length; start += columns) {
			if (start > 0) lines.push("");
			const cells = this.cards
				.slice(start, start + columns)
				.map((card) => card.render(slotWidth));
			const height = Math.max(...cells.map((cell) => cell.length));
			for (let line = 0; line < height; line++) {
				const text = cells.map((cell) => cell[line] ?? " ".repeat(slotWidth)).join("");
				lines.push(padLine(text, width));
			}
		}

		return lines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type === "leave") {
			return this.clearHover() ? this.hoverResult(event) : undefined;
		}
		if (event.type !== "click" && event.type !== "move") return undefined;

		const slotWidth = this.slotWidth(event.width);
		const columns = this.columns(event.width, slotWidth);
		const row = Math.floor(event.y / (CARD_HEIGHT + ROW_GAP));
		const y = event.y - row * (CARD_HEIGHT + ROW_GAP);
		const column = Math.floor(event.x / slotWidth);
		const card =
			y < CARD_HEIGHT && column < columns
				? this.cards[row * columns + column]
				: undefined;

		if (!card) {
			if (event.type !== "move") return undefined;
			return this.hoverResult(event, this.clearHover());
		}

		const cardEvent = {
			...event,
			x: event.x - column * slotWidth,
			y,
			width: slotWidth,
			height: CARD_HEIGHT,
		};

		if (event.type === "move") {
			if (this.hoveredCard !== card) {
				this.hoveredCard?.setHover();
				this.hoveredCard = card;
			}
			card.setHover(cardEvent.x, cardEvent.y);
			return this.hoverResult(event);
		}

		return card.handleMouse?.(cardEvent);
	}

	private clearHover(): boolean {
		if (!this.hoveredCard) return false;
		this.hoveredCard.setHover();
		this.hoveredCard = undefined;
		return true;
	}

	private hoverResult(event: TuiMouseEvent, render = true): HandMouseResult {
		return {
			handled: true,
			render,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	private slotWidth(width: number): number {
		return Math.min(SLOT_WIDTH, Math.max(1, width));
	}

	private columns(width: number, slotWidth: number): number {
		return Math.max(1, Math.floor(Math.max(1, width) / slotWidth));
	}
}
