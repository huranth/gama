export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export type TerminalColorScheme = "dark" | "light";

export interface TerminalColors {
	foreground?: RgbColor;
	background?: RgbColor;
	palette?: RgbColor[];
}

export type OscColorTarget = "foreground" | "background" | number;

const OSC_COLOR_RESPONSE_PATTERN = /^\x1b\](?:(1[01])|4;(\d{1,3}));([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;

const COLOR_SCHEME_REPORT_PATTERN = /^(?:\x1b\[\?997;(1|2)n)+$/;

const hexRadix = 16;

const decimalRadix = 10;

const foregroundSelector = "10";

const backgroundSelector = "11";

const lightReportValue = "2";

const maxChannelValue = 255;

const hexByteDigits = 2;

const wideChannelDigits = 4;

function hexToRgb(hex: string): RgbColor {
	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = parseInt(normalized.slice(0, hexByteDigits), hexRadix);
	const g = parseInt(normalized.slice(hexByteDigits, hexByteDigits * 2), hexRadix);
	const b = parseInt(normalized.slice(hexByteDigits * 2, hexByteDigits * 3), hexRadix);

	return { r, g, b };
}

function parseColorTarget(
	selector: string | undefined,
	paletteIndex: string | undefined,
): OscColorTarget {
	if (selector === foregroundSelector) return "foreground";
	if (selector === backgroundSelector) return "background";

	return Number.parseInt(paletteIndex ?? "", decimalRadix);
}

export function parseOscColorResponse(
	data: string,
): { target: OscColorTarget; rgb: RgbColor | undefined } | undefined {
	const match = data.match(OSC_COLOR_RESPONSE_PATTERN);
	if (!match) {
		return undefined;
	}

	const target = parseColorTarget(match[1], match[2]);

	return { target, rgb: parseOscColorValue(match[3]!) };
}

export function parseTerminalColorSchemeReport(data: string): TerminalColorScheme | undefined {
	const match = data.match(COLOR_SCHEME_REPORT_PATTERN);
	if (!match) {
		return undefined;
	}

	return match[1] === lightReportValue ? "light" : "dark";
}

function parseOscHexChannel(channel: string): number | undefined {
	if (!/^[0-9a-f]+$/i.test(channel)) {
		return undefined;
	}

	const max = hexRadix ** channel.length - 1;
	if (max <= 0) {
		return undefined;
	}

	return Math.round((parseInt(channel, hexRadix) / max) * maxChannelValue);
}

function channelsToRgb(
	red: number | undefined,
	green: number | undefined,
	blue: number | undefined,
): RgbColor | undefined {
	if (red === undefined || green === undefined || blue === undefined) {
		return undefined;
	}

	return { r: red, g: green, b: blue };
}

function parseHexColorValue(value: string): RgbColor | undefined {
	const hex = value.slice(1);
	if (/^[0-9a-f]{6}$/i.test(hex)) {
		return hexToRgb(value);
	}

	if (!/^[0-9a-f]{12}$/i.test(hex)) {
		return undefined;
	}

	return channelsToRgb(
		parseOscHexChannel(hex.slice(0, wideChannelDigits)),
		parseOscHexChannel(hex.slice(wideChannelDigits, wideChannelDigits * 2)),
		parseOscHexChannel(hex.slice(wideChannelDigits * 2, wideChannelDigits * 3)),
	);
}

function parseOscColorValue(rawValue: string): RgbColor | undefined {
	const value = rawValue.trim();

	if (value.startsWith("#")) {
		return parseHexColorValue(value);
	}

	const rgbValue = value.replace(/^rgba?:/i, "");
	const [red, green, blue] = rgbValue.split("/");

	return channelsToRgb(
		red === undefined ? undefined : parseOscHexChannel(red),
		green === undefined ? undefined : parseOscHexChannel(green),
		blue === undefined ? undefined : parseOscHexChannel(blue),
	);
}
