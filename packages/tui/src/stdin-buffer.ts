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

function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

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
			sequences.push(remaining[0]!);
			pos++;
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

			if (status === "incomplete") {
				seqEnd++;
				continue;
			}

			sequences.push(candidate);
			pos += seqEnd;
			break;
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
	private pasteBuffer: string = "";
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
		this.buffer = "";
		this.pasteMode = false;
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

	private finishPaste(): void {
		const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (endIndex === -1) return;

		const pastedContent = this.pasteBuffer.slice(0, endIndex);
		const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;

		this.emit("paste", pastedContent);

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
			this.finishPaste();
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
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.pasteBuffer = this.buffer;
			this.buffer = "";
			this.finishPaste();
			return;
		}

		this.emitBufferedSequences();
		this.scheduleFlush();
	}
}
