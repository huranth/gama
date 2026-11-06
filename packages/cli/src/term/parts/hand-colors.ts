import { colorToOkhsl, mixColors, okhslColor, type Color } from "@huranth/gama-tui";
import { theme, type ThemeColor } from "../theme/theme.ts";

const STATUS_LIGHTNESS = { dark: 0.7, light: 0.46 };

const STATUS_MIN_SATURATION = 0.65;

const SPOTLIGHT_RADIUS_X = 7;

const SPOTLIGHT_RADIUS_Y = 2.4;

const SPOTLIGHT_STRENGTH = 0.3;

function statusColor(color: ThemeColor): Color {
	const { h, s } = colorToOkhsl(theme.colors[color]);
	return okhslColor(
		h,
		Math.max(s, STATUS_MIN_SATURATION),
		STATUS_LIGHTNESS[theme.appearance],
	);
}

export function handKindColor(kind: string | undefined): ThemeColor {
	switch (kind) {
		case "scout":
			return "mdLink";
		case "digger":
			return "accent";
		case "runner":
			return "text";
		case "critic":
			return "error";
		case "builder":
			return "success";
		default:
			return "accent";
	}
}

export function handSpotlightColor(status: string | undefined): Color | undefined {
	switch (status) {
		case "running":
			return statusColor("success");
		case "failed":
			return statusColor("error");
		default:
			return undefined;
	}
}

export function handSpotlightBg(
	base: Color,
	accent: Color,
	pointer: { x: number; y: number },
	column: number,
	row: number,
): Color {
	const dx = (column - pointer.x) / SPOTLIGHT_RADIUS_X;
	const dy = (row - pointer.y) / SPOTLIGHT_RADIUS_Y;
	const distance = Math.sqrt(dx * dx + dy * dy);
	const falloff = Math.max(0, 1 - distance);
	if (falloff <= 0) return base;
	return mixColors(base, accent, SPOTLIGHT_STRENGTH * falloff ** 1.5, "srgb");
}

export function handStatusColor(status: string | undefined): ThemeColor | Color {
	switch (status) {
		case "running":
			return statusColor("success");
		case "done":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return statusColor("error");
		default:
			return "muted";
	}
}

export function handStatusPaint(status: string | undefined, text: string): string {
	const color = handStatusColor(status);
	return typeof color === "string" ? theme.fg(color, text) : theme.style(text, { fg: color });
}
