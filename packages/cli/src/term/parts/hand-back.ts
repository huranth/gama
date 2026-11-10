import {
	Container,
	padLine,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@huranth/gama-tui";
import { theme } from "../theme/theme.ts";
import { fillHandLine } from "./hand-fill.ts";

const BACK_CARD_WIDTH = 16;

const BACK_CARD_HEIGHT = 3;

const BACK_LABEL = "Back";

export class HandBackComponent extends Container {
	private readonly onBack: () => void;

	constructor(onBack: () => void) {
		super();
		this.onBack = onBack;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const width = Math.min(BACK_CARD_WIDTH, event.width);
		if (event.x < 0 || event.x >= width || event.y < 0 || event.y >= BACK_CARD_HEIGHT) {
			return undefined;
		}
		this.onBack();
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
		const cardWidth = Math.max(1, Math.min(BACK_CARD_WIDTH, width));
		const labelWidth = visibleWidth(BACK_LABEL);
		const left = Math.max(0, Math.floor((cardWidth - labelWidth) / 2));
		const right = Math.max(0, cardWidth - labelWidth - left);
		const label = theme.fg("selectionText", theme.bold(BACK_LABEL));
		const text = truncateToWidth(
			`${" ".repeat(left)}${label}${" ".repeat(right)}`,
			cardWidth,
			"",
		);
		const blank = fillHandLine("", cardWidth, "selectedBg");
		const textLine = fillHandLine(text, cardWidth, "selectedBg");

		return [padLine(blank, width), padLine(textLine, width), padLine(blank, width)];
	}
}
