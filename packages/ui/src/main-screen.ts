import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import {
	type TUI,
	TuiBase,
	type TuiMouseButton,
	type TuiMouseEvent,
	type TuiMouseEventType,
	type TuiStopOptions,
} from "./screen.ts";
import { visibleWidth } from "./utils.ts";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";

const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";

const MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

const MOUSE_WHEEL = 64;

const MOUSE_SHIFT = 4;

const MOUSE_ALT = 8;

const MOUSE_CTRL = 16;

const BUTTON_MASK = 3;

const TERMINAL_INDEX_BASE = 1;

const UNKNOWN_DIMENSION = -1;

const SYNC_OUTPUT_START = "\x1b[?2026h";

const SYNC_OUTPUT_END = "\x1b[?2026l";

function mouseButton(code: number): TuiMouseButton {
	if ((code & MOUSE_WHEEL) !== 0) return "none";
	const button = code & BUTTON_MASK;
	if (button === 0) return "left";
	if (button === 1) return "middle";
	if (button === 2) return "right";
	return "none";
}

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

export interface MainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

const KITTY_PARAM_MAX = 0xffffffff;

const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

const SURROGATE_HIGH_START = 0xd800;

const SURROGATE_HIGH_END = 0xdbff;

const SURROGATE_LOW_START = 0xdc00;

const SURROGATE_LOW_END = 0xdfff;

class BoundedTerminalWriter {
	private buffer = "";
	private writtenChars = 0;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	append(value: string): void {
		let offset = 0;
		while (offset < value.length) {
			const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
			if (capacity === 0) {
				this.flush();
				continue;
			}

			let end = Math.min(value.length, offset + capacity);
			if (
				end < value.length &&
				value.charCodeAt(end - 1) >= SURROGATE_HIGH_START &&
				value.charCodeAt(end - 1) <= SURROGATE_HIGH_END &&
				value.charCodeAt(end) >= SURROGATE_LOW_START &&
				value.charCodeAt(end) <= SURROGATE_LOW_END
			) {
				end--;
			}
			if (end === offset) {
				this.flush();
				continue;
			}

			this.buffer += value.slice(offset, end);
			offset = end;
			if (this.buffer.length === MAX_RENDER_WRITE_CHARS) {
				this.flush();
			}
		}
	}

	flush(): void {
		if (!this.buffer) return;
		this.write(this.buffer);
		this.writtenChars += this.buffer.length;
		this.buffer = "";
	}

	get length(): number {
		return this.writtenChars + this.buffer.length;
	}
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > KITTY_PARAM_MAX) {
			continue;
		}
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

export class MainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	private mouseTracking = false;
	private modalMouse = false;
	private stopMouseInput: (() => void) | undefined;
	private pressedCell: { x: number; y: number } | undefined;

	captureRenderState(): MainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: MainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = UNKNOWN_DIMENSION;
		this.previousHeight = UNKNOWN_DIMENSION;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	override start(): void {
		if (this.started) return;
		this.stopMouseInput = this.addInputListener((data) => this.consumeMouseInput(data));
		super.start();
		if (this.started) this.applyMouseTracking(true);
	}

	override stop(options: TuiStopOptions = {}): void {
		if (this.started) {
			this.stopMouseInput?.();
			this.stopMouseInput = undefined;
			this.disableMouseTracking();
		}
		super.stop(options);
	}

	private disableMouseTracking(): void {
		const wasTracking = this.mouseTracking;
		this.mouseTracking = false;
		this.pressedCell = undefined;
		if (wasTracking && !this.stopped) this.terminal.write(DISABLE_MOUSE);
	}

	setMouseTracking(enabled: boolean): void {
		this.modalMouse = enabled;
		this.applyMouseTracking();
	}

	private applyMouseTracking(force = false): void {
		const enabled = this.modalMouse || this.hasOverlay();
		if (!force && this.mouseTracking === enabled) return;
		this.mouseTracking = enabled;
		this.pressedCell = undefined;
		if (!this.started || this.stopped) return;
		this.terminal.write(enabled ? ENABLE_MOUSE : DISABLE_MOUSE);
	}

	private consumeMouseInput(data: string): { consume: boolean } | undefined {
		if (!this.mouseTracking) return undefined;
		const match = data.match(MOUSE_PATTERN);
		if (!match) return undefined;

		const code = Number(match[1]);
		const x = Number(match[2]) - TERMINAL_INDEX_BASE;
		const y = Number(match[3]) - TERMINAL_INDEX_BASE;
		if ((code & MOUSE_WHEEL) !== 0) {
			this.dispatchWheel(code, x, y);
		} else if (match[4] === "m") {
			this.dispatchRelease(code, x, y);
		} else {
			this.dispatchPress(code, x, y);
		}
		return { consume: true };
	}

	private dispatchPress(code: number, x: number, y: number): void {
		this.pressedCell = { x, y };
		this.dispatchMouse(this.mouseEvent("press", code, x, y));
	}

	private dispatchRelease(code: number, x: number, y: number): void {
		const pressed = this.pressedCell;
		this.pressedCell = undefined;
		this.dispatchMouse(this.mouseEvent("release", code, x, y));
		if (!pressed || pressed.x !== x || pressed.y !== y) return;
		this.dispatchMouse(this.mouseEvent("click", code, x, y, undefined, 1));
	}

	private dispatchWheel(code: number, x: number, y: number): void {
		this.dispatchMouse(this.mouseEvent("wheel", code, x, y, (code & 1) === 0 ? -1 : 1));
	}

	private mouseEvent(
		type: TuiMouseEventType,
		code: number,
		x: number,
		y: number,
		wheelDelta?: number,
		clickCount?: number,
	): TuiMouseEvent {
		const top = Math.max(0, this.previousLines.length - this.terminal.rows);
		const line = top + y;

		return {
			type,
			button: mouseButton(code),
			x,
			y: line,
			screenX: x,
			screenY: line,
			width: Math.max(1, this.terminal.columns),
			height: Math.max(1, this.previousLines.length),
			shift: (code & MOUSE_SHIFT) !== 0,
			alt: (code & MOUSE_ALT) !== 0,
			ctrl: (code & MOUSE_CTRL) !== 0,
			...(wheelDelta === undefined ? {} : { wheelDelta }),
			...(clickCount === undefined ? {} : { clickCount }),
		};
	}

	private dispatchMouse(event: TuiMouseEvent): void {
		const overlay = this.dispatchMouseToOverlay(event);
		const result = overlay.result ?? (overlay.hit ? undefined : this.handleMouse(event));
		if (!result) return;

		if (result.focus) {
			const target = result.focusTarget ?? result.target.component;
			this.setFocus(this.resolveMouseFocusTarget(target));
		}

		if (result.render !== false) this.requestRender();
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		if (options.clearScreen) {
			const screenRow = Math.max(0, this.hardwareCursorRow - this.previousViewportTop);
			let sequence = "\x1b[0m\r";
			if (screenRow > 0) sequence += `\x1b[${screenRow}A`;
			sequence += "\x1b[0J\x1b[?25h";
			if (this.terminal.writeSync) {
				this.terminal.writeSync(sequence);
			} else {
				this.terminal.write(sequence);
			}
			return;
		}
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(
		lines: string[],
		index: number,
		maxIndex = lines.length - 1,
	): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	private ensureLineFits(line: string, index: number, lines: string[], width: number): void {
		if (isImageLine(line) || visibleWidth(line) <= width) return;

		const crashLogPath = path.join(this.logDirectory ?? os.tmpdir(), "gama-tui-crash.log");
		const crashData = [
			`Crash at ${new Date().toISOString()}`,
			`Terminal width: ${width}`,
			`Line ${index} visible width: ${visibleWidth(line)}`,
			"",
			"All rendered lines:",
			...lines.map((entry, row) => `[${row}] (w=${visibleWidth(entry)}) ${entry}`),
			"",
		].join("\n");
		let logged = false;
		try {
			fs.mkdirSync(path.dirname(crashLogPath), { recursive: true, mode: 0o700 });
			fs.writeFileSync(crashLogPath, crashData, { mode: 0o600 });
			logged = true;
		} catch {}

		this.stop();

		const errorLines = [
			`Rendered line ${index} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
			"",
			"This is likely caused by a custom TUI component not truncating its output.",
			"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
		];
		if (logged) errorLines.push("", `Debug log written to: ${crashLogPath}`);
		throw new Error(errorLines.join("\n"));
	}

	protected doRender(): void {
		if (this.stopped) return;
		this.applyMouseTracking();
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength =
			this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged
			? Math.max(0, previousBufferLength - height)
			: this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		let newLines = this.render(width);

		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);

		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append(SYNC_OUTPUT_START);
			if (clear) {
				output.append(this.deleteKittyImages(this.previousKittyImageIds));
				output.append("\x1b[2J\x1b[H");
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) output.append("\r\n");
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						output.append("\r\n");
					}
					output.append(`\x1b[${imageReservedRows - 1}A`);
					output.append(line);
					output.append(`\x1b[${imageReservedRows - 1}B`);
					i += imageReservedRows - 1;
					continue;
				}
				this.ensureLineFits(line, i, newLines, width);
				output.append(line);
			}
			output.append(SYNC_OUTPUT_END);
			output.flush();
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const redrawLogDirectory =
			process.env.GAMA_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
		const logRedraw = (reason: string): void => {
			if (redrawLogDirectory === undefined) return;
			const logPath = path.join(redrawLogDirectory, "gama-tui-debug.log");
			const stamp = new Date().toISOString();
			const counts = `prev=${this.previousLines.length}, new=${newLines.length}`;
			const msg = `[${stamp}] fullRender: ${reason} (${counts}, height=${height})\n`;
			try {
				fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
				fs.appendFileSync(logPath, msg, { mode: 0o600 });
			} catch {}
		};

		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		if (
			this.getClearOnShrink() &&
			newLines.length < this.maxLinesRendered &&
			!this.hasOverlayEntries
		) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(
				firstChanged,
				lastChanged,
				newLines,
			);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart =
			appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append(SYNC_OUTPUT_START);
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					output.append(`\x1b[${clearStartOffset}B`);
				}
				for (let i = 0; i < extraLines; i++) {
					output.append("\r\x1b[2K");
					if (i < extraLines - 1) output.append("\x1b[1B");
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					output.append(`\x1b[${moveBack}A`);
				}
				output.append(SYNC_OUTPUT_END);
				output.flush();
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append(SYNC_OUTPUT_START);
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(
				0,
				Math.min(height - 1, hardwareCursorRow - prevViewportTop),
			);
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`);
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`);
		}

		output.append(appendStart ? "\r\n" : "\r");

		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) output.append("\r\n");
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage
				? this.getKittyImageReservedRows(newLines, i, renderEnd)
				: 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					const overflow = `${imageStartScreenRow} + ${imageReservedRows} > ${height}`;
					logRedraw(`kitty image pre-clear would scroll (${overflow})`);
					fullRender(true);
					return;
				}

				output.append("\x1b[2K");
				for (let row = 1; row < imageReservedRows; row++) {
					output.append("\r\n\x1b[2K");
				}
				output.append(`\x1b[${imageReservedRows - 1}A`);
				output.append(line);
				output.append(`\x1b[${imageReservedRows - 1}B`);
				i += imageReservedRows - 1;
				continue;
			}

			output.append("\x1b[2K");
			this.ensureLineFits(line, i, newLines, width);
			output.append(line);
		}

		let finalCursorRow = renderEnd;

		if (this.previousLines.length > newLines.length) {
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				output.append("\r\n\x1b[2K");
			}
			output.append(`\x1b[${extraLines}A`);
		}

		output.append(SYNC_OUTPUT_END);

		if (process.env.GAMA_TUI_DEBUG === "1") {
			const debugDir = path.join(os.tmpdir(), "tui");
			const debugPath = path.join(
				debugDir,
				`render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
			);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"newLines:",
				JSON.stringify(newLines, null, 2),
				"",
				"previousLines:",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"buffer:",
				`[${output.length} chars written in bounded chunks]`,
			].join("\n");
			try {
				fs.mkdirSync(debugDir, { recursive: true, mode: 0o700 });
				fs.writeFileSync(debugPath, debugData, { mode: 0o600 });
			} catch {}
		}

		output.flush();

		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	private positionHardwareCursor(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
	): void {
		if (!cursorPos || totalLines <= 0) {
			this.updateHardwareCursorVisibility(false);
			return;
		}

		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`;
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`;
		}
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		this.updateHardwareCursorVisibility(this.getShowHardwareCursor());
	}

	private updateHardwareCursorVisibility(visible: boolean): void {
		if (this.isHardwareCursorVisible() === visible) return;

		this.setHardwareCursorVisible(visible);

		if (visible) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
