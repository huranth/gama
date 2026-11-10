import type { TuiMouseButton, TuiMouseEvent, TuiMouseEventType } from "../screen.ts";

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

export interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}

type MouseEventExtra = Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">>;

const altWheelScrollMultiplier = 5;

const sgrMousePattern = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

const sgrWheelPattern = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;

export function decodeMouseButton(button: number): TuiMouseButton {
	switch (button & 3) {
		case 0:
			return "left";
		case 1:
			return "middle";
		case 2:
			return "right";
		default:
			return "none";
	}
}

export function isMouseSequence(data: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = sgrMousePattern.exec(data);
	if (!match) return undefined;
	return {
		button: Number.parseInt(match[1], 10),
		x: Number.parseInt(match[2], 10) - 1,
		y: Number.parseInt(match[3], 10) - 1,
		release: match[4] === "m",
	};
}

export function parseWheelEvent(data: string): WheelEvent | undefined {
	const sgr = sgrWheelPattern.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1], 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return {
			direction: direction === 0 ? -1 : 1,
			x: Number.parseInt(sgr[2], 10) - 1,
			y: Number.parseInt(sgr[3], 10) - 1,
			button,
		};
	}
	if (data.length !== 6 || !data.startsWith("\x1b[M")) return undefined;
	const button = data.charCodeAt(3) - 32;
	if ((button & 64) === 0) return undefined;
	const direction = button & 3;
	if (direction !== 0 && direction !== 1) return undefined;
	return {
		direction: direction === 0 ? -1 : 1,
		x: data.charCodeAt(4) - 33,
		y: data.charCodeAt(5) - 33,
		button,
	};
}

export function resolveWheelDelta(event: WheelEvent, lines: number): number {
	const accelerated = (event.button & 8) !== 0 ? lines * altWheelScrollMultiplier : lines;
	return event.direction * accelerated;
}

export function createMouseEvent(
	type: TuiMouseEventType,
	button: number,
	x: number,
	y: number,
	columns: number,
	rows: number,
	extra: MouseEventExtra = {},
): TuiMouseEvent {
	return {
		type,
		button: type === "wheel" ? "none" : decodeMouseButton(button),
		x,
		y,
		screenX: x,
		screenY: y,
		width: Math.max(1, columns),
		height: Math.max(1, rows),
		shift: (button & 4) !== 0,
		alt: (button & 8) !== 0,
		ctrl: (button & 16) !== 0,
		...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
		...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
	};
}
