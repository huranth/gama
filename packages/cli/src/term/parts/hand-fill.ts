import {
	backgroundAnsi,
	padLine,
	sliceByColumn,
	type Color,
	visibleWidth,
} from "@huranth/gama-tui";
import { ANSI_NO_BACKGROUND, ANSI_RESET, theme, type ThemeBg } from "../theme/theme.ts";

export type HandFillBg = ThemeBg | Color;

export type HandBgAt = (column: number) => HandFillBg;

export function handBackgroundAnsi(background: HandFillBg): string {
	return typeof background === "string"
		? theme.getBgAnsi(background)
		: backgroundAnsi(background, theme.getColorMode());
}

export function fillHandLine(
	content: string,
	width: number,
	background: HandFillBg,
	backgroundAt?: HandBgAt,
): string {
	const padded = padLine(content, width);
	if (!backgroundAt) {
		const bg = handBackgroundAnsi(background);
		return padded
			.split(ANSI_RESET)
			.map((segment) => `${bg}${segment}${ANSI_NO_BACKGROUND}`)
			.join(ANSI_RESET);
	}

	let result = "";
	for (let column = 0; column < width; ) {
		const cell = sliceByColumn(padded, column, 1);
		const cellWidth = visibleWidth(cell);
		const bg = handBackgroundAnsi(backgroundAt(column));
		if (cellWidth === 0) {
			result += `${bg} `;
			column += 1;
			continue;
		}
		result += `${bg}${cell.split(ANSI_RESET).join(`${ANSI_RESET}${bg}`)}`;
		column += cellWidth;
	}
	return `${result}${ANSI_NO_BACKGROUND}`;
}
