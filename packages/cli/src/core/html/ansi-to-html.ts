interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
}

const ANSI_COLORS = [
	"#000000",
	"#800000",
	"#008000",
	"#808000",
	"#000080",
	"#800080",
	"#008080",
	"#c0c0c0",
	"#808080",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#0000ff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

const FG_START = 30;

const BG_START = 40;

const FG_BRIGHT_START = 90;

const BG_BRIGHT_START = 100;

const BRIGHT_OFFSET = 8;

const CUBE_START = 16;

const GRAY_START = 232;

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const GRAY_BASE = 8;

const GRAY_STEP = 10;

const SGR_EXTENDED_FG = 38;

const SGR_EXTENDED_BG = 48;

const SGR_COLOR_MODE_256 = 5;

const SGR_COLOR_MODE_RGB = 2;

const HTML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#039;",
};

// Plain codes
const SGR_SIMPLE: Record<number, (style: TextStyle) => void> = {
	0: (style) => Object.assign(style, createEmptyStyle()),
	1: (style) => {
		style.bold = true;
	},
	2: (style) => {
		style.dim = true;
	},
	3: (style) => {
		style.italic = true;
	},
	4: (style) => {
		style.underline = true;
	},
	22: (style) => {
		style.bold = false;
		style.dim = false;
	},
	23: (style) => {
		style.italic = false;
	},
	24: (style) => {
		style.underline = false;
	},
	39: (style) => {
		style.fg = null;
	},
	49: (style) => {
		style.bg = null;
	},
};

function hex2(value: number): string {
	return value.toString(16).padStart(2, "0");
}

function color256ToHex(index: number): string {
	if (index < CUBE_START) return ANSI_COLORS[index] ?? ANSI_COLORS[0];

	if (index < GRAY_START) {
		const cubeIndex = index - CUBE_START;
		const r = CUBE_LEVELS[Math.floor(cubeIndex / 36)] ?? 0;
		const g = CUBE_LEVELS[Math.floor((cubeIndex % 36) / 6)] ?? 0;
		const b = CUBE_LEVELS[cubeIndex % 6] ?? 0;

		return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
	}

	const gray = GRAY_BASE + (index - GRAY_START) * GRAY_STEP;
	const grayHex = hex2(gray);

	return `#${grayHex}${grayHex}${grayHex}`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];

	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");

	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return (
		style.fg !== null ||
		style.bg !== null ||
		style.bold ||
		style.dim ||
		style.italic ||
		style.underline
	);
}

// Extended color
function readExtendedColor(
	params: number[],
	index: number,
): { value: string; skip: number } | undefined {
	const mode = params[index + 1];

	if (mode === SGR_COLOR_MODE_256 && params.length > index + 2) {
		return { value: color256ToHex(params[index + 2] ?? 0), skip: 2 };
	}

	if (mode === SGR_COLOR_MODE_RGB && params.length > index + 4) {
		const r = params[index + 2] ?? 0;
		const g = params[index + 3] ?? 0;
		const b = params[index + 4] ?? 0;

		return { value: `rgb(${r},${g},${b})`, skip: 4 };
	}

	return undefined;
}

function applySgrCode(params: number[], style: TextStyle): void {
	for (let i = 0; i < params.length; i++) {
		const code = params[i] ?? 0;
		const simple = SGR_SIMPLE[code];

		if (simple) {
			simple(style);
			continue;
		}

		if (code >= FG_START && code < FG_START + BRIGHT_OFFSET) {
			style.fg = ANSI_COLORS[code - FG_START] ?? null;
			continue;
		}

		if (code >= BG_START && code < BG_START + BRIGHT_OFFSET) {
			style.bg = ANSI_COLORS[code - BG_START] ?? null;
			continue;
		}

		if (code >= FG_BRIGHT_START && code < FG_BRIGHT_START + BRIGHT_OFFSET) {
			style.fg = ANSI_COLORS[code - FG_BRIGHT_START + BRIGHT_OFFSET] ?? null;
			continue;
		}

		if (code >= BG_BRIGHT_START && code < BG_BRIGHT_START + BRIGHT_OFFSET) {
			style.bg = ANSI_COLORS[code - BG_BRIGHT_START + BRIGHT_OFFSET] ?? null;
			continue;
		}

		if (code !== SGR_EXTENDED_FG && code !== SGR_EXTENDED_BG) continue;

		const color = readExtendedColor(params, i);
		if (!color) continue;

		if (code === SGR_EXTENDED_FG) style.fg = color.value;
		else style.bg = color.value;

		i += color.skip;
	}
}

export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	while (match !== null) {
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) result += escapeHtml(beforeText);

		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		applySgrCode(params, style);

		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	const remainingText = text.slice(lastIndex);
	if (remainingText) result += escapeHtml(remainingText);
	if (inSpan) result += "</span>";

	return result;
}

export function ansiLinesToHtml(lines: string[]): string {
	return lines
		.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`)
		.join("");
}
