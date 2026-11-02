import { EventEmitter } from "events";

export type StdinBufferOptions = {
	timeout?: number;
	escapeTimeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

const ESC = "\x1b";

const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;

const DEFAULT_ESCAPE_TIMEOUT_MS = 10;

const BRACKETED_PASTE_START = "\x1b[200~";

const BRACKETED_PASTE_END = "\x1b[201~";

const PASTE_TIMEOUT_MS = 1000;

const MAX_PASTE_CHARS = 1_000_000;

const PASTE_END_TAIL = BRACKETED_PASTE_END.length - 1;

function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	return data.endsWith(`${ESC}\\`) ? "complete" : "incomplete";
}

function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	return data.endsWith(`${ESC}\\`) ? "complete" : "incomplete";
}

function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	return data.endsWith(`${ESC}\\`) || data.endsWith("\x07") ? "complete" : "incomplete";
}

function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);
	const lastChar = payload[payload.length - 1]!;
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode < 0x40 || lastCharCode > 0x7e) {
		return "incomplete";
	}

	if (!payload.startsWith("<")) {
		return "complete";
	}

	const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
	if (mouseMatch) {
		return "complete";
	}

	if (lastChar === "M" || lastChar === "m") {
		const parts = payload.slice(1, -1).split(";");
		if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
			return "complete";
		}
	}

	return "incomplete";
}

function isCompleteSequence(data: string): "complete" | "incomplete" {
	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	if (afterEsc.startsWith("[")) {
		if (afterEsc.startsWith("[M")) {
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	if (afterEsc.startsWith("O")) {
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	return "complete";
}

function isSequenceStart(char: string | undefined): boolean {
	return char === "[" || char === "]" || char === "O" || char === "P" || char === "_";
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		if (!remaining.startsWith(ESC)) {
			const char = String.fromCodePoint(remaining.codePointAt(0)!);
			sequences.push(char);
			pos += char.length;
			continue;
		}

		let seqEnd = 1;
		while (seqEnd <= remaining.length) {
			const candidate = remaining.slice(0, seqEnd);
			const status = isCompleteSequence(candidate);

			if (status === "complete") {
				const splitsEscapeEscape =
					candidate === "\x1b\x1b" && isSequenceStart(remaining[seqEnd]);
				if (splitsEscapeEscape) {
					sequences.push(ESC);
					pos += 1;
					break;
				}
				sequences.push(candidate);
				pos += seqEnd;
				break;
			}

			seqEnd++;
		}

		if (seqEnd > remaining.length) {
			return { sequences, remainder: remaining };
		}
	}

	return { sequences, remainder: "" };
}

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly escapeTimeoutMs: number;
	private pasteMode: boolean = false;
	private pasteDropping: boolean = false;
	private pasteBuffer: string = "";
	private pasteTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
		this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
	}

	getBuffer(): string {
		return this.buffer;
	}

	clear(): void {
		this.clearFlushTimer();
		this.clearPasteTimer();
		this.buffer = "";
		this.pasteMode = false;
		this.pasteDropping = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	destroy(): void {
		this.clear();
	}

	flush(): string[] {
		this.clearFlushTimer();
		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	private clearFlushTimer(): void {
		if (!this.timeout) return;
		clearTimeout(this.timeout);
		this.timeout = null;
	}

	private toInputString(data: string | Buffer): string {
		if (!Buffer.isBuffer(data)) {
			return data;
		}

		if (data.length !== 1 || data[0]! <= 127) {
			return data.toString();
		}

		const byte = data[0]! - 128;
		return `\x1b${String.fromCharCode(byte)}`;
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	private trimPaste(): { content: string; remaining: string; ended: boolean } {
		const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (endIndex === -1) {
			return { content: this.pasteBuffer, remaining: "", ended: false };
		}
		return {
			content: this.pasteBuffer.slice(0, endIndex),
			remaining: this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length),
			ended: true,
		};
	}

	private finishPaste(): void {
		const { content, remaining, ended } = this.trimPaste();
		if (!ended) return;

		this.clearPasteTimer();
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;

		this.emit("paste", content);

		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	private capPaste(): void {
		const { content, ended } = this.trimPaste();

		if (ended) {
			this.finishPaste();
			return;
		}

		this.clearPasteTimer();
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;

		if (content.length > 0) this.emit("paste", content);

		this.pasteDropping = true;
	}

	private handlePasteChunk(): void {
		if (this.trimPaste().content.length > MAX_PASTE_CHARS) {
			this.capPaste();
			return;
		}

		this.finishPaste();
	}

	private dropPasteTail(): void {
		const { remaining, ended } = this.trimPaste();

		if (!ended) {
			this.pasteBuffer = this.pasteBuffer.slice(-PASTE_END_TAIL);
			return;
		}

		this.clearPasteTimer();
		this.pasteMode = false;
		this.pasteDropping = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;

		if (remaining.length > 0) this.process(remaining);
	}

	private clearPasteTimer(): void {
		if (this.pasteTimer === null) return;
		clearTimeout(this.pasteTimer);
		this.pasteTimer = null;
	}

	private schedulePasteFlush(): void {
		this.clearPasteTimer();
		this.pasteTimer = setTimeout(() => this.flushPaste(), PASTE_TIMEOUT_MS);
		this.pasteTimer.unref?.();
	}

	private flushPaste(): void {
		if (!this.pasteMode) return;

		const dropping = this.pasteDropping;
		const { content, remaining } = this.trimPaste();

		this.pasteMode = false;
		this.pasteDropping = false;
		this.pasteBuffer = "";
		this.clearPasteTimer();
		this.pendingKittyPrintableCodepoint = undefined;

		if (!dropping && content.length > 0) this.emit("paste", content);

		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	private emitBufferedSequences(): void {
		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}
	}

	private scheduleFlush(): void {
		if (this.buffer.length === 0) return;

		const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
		this.timeout = setTimeout(() => {
			for (const sequence of this.flush()) {
				this.emitDataSequence(sequence);
			}
		}, timeoutMs);
	}

	process(data: string | Buffer): void {
		this.clearFlushTimer();

		const str = this.toInputString(data);

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		this.buffer += str;

		if (this.pasteMode) {
			this.pasteBuffer += this.buffer;
			this.buffer = "";

			if (this.pasteDropping) {
				this.dropPasteTail();
			} else {
				this.handlePasteChunk();
			}

			if (this.pasteMode) this.schedulePasteFlush();
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
				if (result.remainder) {
					this.emitDataSequence(result.remainder);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";
			this.handlePasteChunk();
			if (this.pasteMode) this.schedulePasteFlush();
			return;
		}

		this.emitBufferedSequences();
		this.scheduleFlush();
	}
}
