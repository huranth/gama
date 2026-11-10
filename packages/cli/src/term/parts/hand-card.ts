import {
	Container,
	padLine,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@huranth/gama-tui";
import type { HandSnapshot } from "../../core/hands.ts";
import { theme } from "../theme/theme.ts";
import { handKindColor, handSpotlightBg, handSpotlightColor } from "./hand-colors.ts";
import { fillHandLine, type HandBgAt, type HandFillBg, handBackgroundAnsi } from "./hand-fill.ts";

const CARD_MAX_WIDTH = 28;

const CARD_PAD_X = 2;

const CARD_MARGIN = 1;

const CARD_HEIGHT = 5;

function capitalize(value: string): string {
	return value.replace(/^./, (letter) => letter.toUpperCase());
}

export class HandCardComponent extends Container {
	private snapshot: HandSnapshot;
	private readonly onOpen: () => void;
	private hover: { x: number; y: number } | undefined;

	constructor(snapshot: HandSnapshot, onOpen: () => void) {
		super();
		this.snapshot = snapshot;
		this.onOpen = onOpen;
	}

	setSnapshot(snapshot: HandSnapshot): void {
		this.snapshot = snapshot;
		this.invalidate();
	}

	setHover(x?: number, y?: number): void {
		if (x === undefined || y === undefined) {
			if (!this.hover) return;
			this.hover = undefined;
			this.invalidate();
			return;
		}
		if (this.hover?.x === x && this.hover.y === y) return;
		this.hover = { x, y };
		this.invalidate();
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const { margin, cardWidth } = this.metrics(event.width);
		const inCardX = event.x >= margin && event.x < margin + cardWidth;
		const inCardY = event.y >= 0 && event.y < CARD_HEIGHT;
		if (!inCardX || !inCardY) return undefined;
		this.onOpen();
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	override render(width: number): string[] {
		const { margin, cardWidth } = this.metrics(width);
		const title = this.snapshot.title;
		const role = capitalize(this.snapshot.kind);
		const roleColor = handKindColor(this.snapshot.kind);
		const roleLabel = ` ${role} `;
		const cardBg = "handBg" as const;
		const cardBgAnsi = handBackgroundAnsi(cardBg);
		const baseColor = theme.colors.handBg;
		const spotlightAccent = handSpotlightColor(this.snapshot.status);
		const pointerX = this.hover ? this.hover.x - margin : -1;
		const pointer =
			spotlightAccent && this.hover && pointerX >= 0 && pointerX < cardWidth
				? {
						x: pointerX,
						y: Math.min(CARD_HEIGHT - 1, Math.max(0, this.hover.y)),
					}
				: undefined;
		const bgAt = (row: number): HandBgAt | undefined => {
			if (!pointer || !spotlightAccent) return undefined;
			return (column) => handSpotlightBg(baseColor, spotlightAccent, pointer, column, row);
		};
		const roleChip = `${theme.getBgAnsi("handChipBg")}${theme.fg(
			roleColor,
			roleLabel,
		)}${cardBgAnsi}`;

		const rows = [
			this.place("", "", cardWidth, margin, cardBg, bgAt(0)),
			this.place(title, theme.fg("text", theme.bold(title)), cardWidth, margin, cardBg, bgAt(1)),
			this.place("", "", cardWidth, margin, cardBg, bgAt(2)),
			this.place(roleLabel, roleChip, cardWidth, margin, cardBg, bgAt(3)),
			this.place("", "", cardWidth, margin, cardBg, bgAt(4)),
		];

		return rows.map((row) => padLine(row, width));
	}

	private metrics(width: number): { margin: number; cardWidth: number } {
		const safeWidth = Math.max(1, width);
		const margin = Math.min(CARD_MARGIN, Math.max(0, safeWidth - 4));
		const cardWidth = Math.max(1, Math.min(CARD_MAX_WIDTH, safeWidth - margin * 2));
		return { margin, cardWidth };
	}

	private place(
		plain: string,
		styled: string,
		cardWidth: number,
		margin: number,
		bg: HandFillBg,
		cellBackground?: HandBgAt,
	): string {
		const padX = Math.min(CARD_PAD_X, Math.max(0, Math.floor(cardWidth / 4)));
		const innerWidth = Math.max(0, cardWidth - padX * 2);
		const left = Math.max(0, Math.floor((innerWidth - visibleWidth(plain)) / 2));
		const text = plain ? `${" ".repeat(left)}${styled}` : "";
		const clipped = truncateToWidth(text, innerWidth, "");
		const row = `${" ".repeat(padX)}${padLine(clipped, innerWidth)}${" ".repeat(padX)}`;
		return `${" ".repeat(margin)}${fillHandLine(row, cardWidth, bg, cellBackground)}`;
	}
}
