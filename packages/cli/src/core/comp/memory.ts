import type { AgentMessage } from "@huranth/gama-agent-core";
import { contentText } from "@huranth/gama-ai";
import type { FileOperations } from "./utils.ts";

const MEMORY_MAX_CHARS = 6000;

const FILE_MAX_CHARS = 2200;

const OUTLINE_MAX_CHARS = 360;

const OUTLINE_MAX_ENTRIES = 16;

const REQUEST_MAX_CHARS = 320;

const MAX_REQUESTS = 6;

const COMMAND_MAX_CHARS = 140;

const MAX_COMMANDS = 8;

const ANSWER_MAX_CHARS = 400;

const MAX_ANSWERS = 3;

const READ_STATUS_PREFIXES = ["[FILE_DOES_NOT_EXIST]", "[FILE_TOO_LARGE]", "[IMAGE]"];

const OUTLINE_LINE_CHARS = 70;

const MIN_FENCE = 3;

const HEAD_FRACTION = 0.7;

// Declaration pattern
const DECL_HEAD = "(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?";

const DECL_TAIL = "(?:abstract\\s+)?(?:async\\s+)?";

const DECL_BODY = "(?:function\\b|class\\b|interface\\b|type\\s+\\w|enum\\b|namespace\\b)";

const DECLARATION_PATTERNS = [
	new RegExp(`^${DECL_HEAD}${DECL_TAIL}${DECL_BODY}`),
	/^export\s+(const|let|var)\b/,
	/^(async\s+)?def\s+\w/,
	/^class\s+\w/,
	/^func\s/,
	/^type\s+\w+\s+(struct|interface)\b/,
	/^(pub(\([^)]*\))?\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod)\b/,
	/^#{1,3}\s+\S/,
];

interface ReadRecord {
	path: string;
	content: string;
	order: number;
	offset: number;
}

interface CommandRecord {
	command: string;
	failed: boolean;
	error?: string;
}

interface AnswerRecord {
	text: string;
}

interface CallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

interface Facts {
	requests: string[];
	reads: ReadRecord[];
	edits: Map<string, number>;
	attemptedEdits: Map<string, number>;
	failedEdits: Set<string>;
	commands: CommandRecord[];
	answers: AnswerRecord[];
}

function stringArg(
	args: Record<string, unknown> | undefined,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function pathOf(args: Record<string, unknown> | undefined): string | undefined {
	return stringArg(args, "path", "file_path", "filePath");
}

function isImageResult(message: Extract<AgentMessage, { role: "toolResult" }>): boolean {
	return message.content.some((part) => part.type === "image");
}

function lineLabel(content: string): string {
	const count = content === "" ? 0 : content.split("\n").length;
	return `${count} line${count === 1 ? "" : "s"}`;
}

function truncateMiddle(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	const placeholderLength = "\n[...  chars truncated ...]\n".length;
	const available = Math.max(0, maxChars - placeholderLength);
	const head = Math.ceil(available * HEAD_FRACTION);
	const tail = available - head;
	const notice = `\n[... ${chars.length - available} chars truncated ...]\n`;
	const rest = tail > 0 ? chars.slice(-tail).join("") : "";

	return `${chars.slice(0, head).join("")}${notice}${rest}`;
}

function truncateEnd(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;

	return `${chars.slice(0, Math.max(0, maxChars - 3)).join("")}...`;
}

// Top-level
export function outlineOf(content: string, offset = 0): string {
	const lines = content.split("\n");
	const entries: string[] = [];
	let more = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!DECLARATION_PATTERNS.some((pattern) => pattern.test(line))) continue;
		if (entries.length >= OUTLINE_MAX_ENTRIES) {
			more++;
			continue;
		}
		const text = line.trim().replace(/\s*\{$/, "");
		entries.push(`L${offset + i + 1} ${truncateEnd(text, OUTLINE_LINE_CHARS)}`);
	}
	if (more > 0) entries.push(`... ${more} more`);
	return entries.join("; ");
}

function errorLine(text: string): string | undefined {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const explicit = lines.findLast((line) => /error|failed|fatal|cannot|not found/i.test(line));
	return truncateEnd(explicit ?? lines[lines.length - 1], COMMAND_MAX_CHARS);
}

function fenceFor(content: string): string {
	const runs = content.match(/`+/g) ?? [];
	const longest = runs.reduce((size, run) => Math.max(size, run.length), 0);

	return "`".repeat(Math.max(MIN_FENCE, longest + 1));
}

function formatFileBlock(path: string, content: string, label: string): string {
	const fence = fenceFor(content);
	const body = truncateMiddle(content, FILE_MAX_CHARS);
	return `- ${path} (${label})\n${fence}\n${body}\n${fence}\n`;
}

function formatOutlineBlock(path: string, read: ReadRecord, reason: string): string {
	const outline = outlineOf(read.content, read.offset - 1);
	const label = `read, ${lineLabel(read.content)}; ${reason}`;
	if (!outline) return `- ${path} (${label})\n`;

	return `- ${path} (${label})\n  Outline: ${truncateEnd(outline, OUTLINE_MAX_CHARS)}\n`;
}

function collect(messages: AgentMessage[]): Facts {
	const facts: Facts = {
		requests: [],
		reads: [],
		edits: new Map(),
		attemptedEdits: new Map(),
		failedEdits: new Set(),
		commands: [],
		answers: [],
	};
	const calls = new Map<string, CallInfo>();
	let order = 0;

	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content, "").trim();
			if (text && text !== facts.requests[facts.requests.length - 1]) {
				facts.requests.push(text);
			}
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const args = (block.arguments ?? {}) as Record<string, unknown>;
				calls.set(block.id, { name: block.name, arguments: args });
				const path = pathOf(args);
				if (path && (block.name === "write" || block.name === "edit")) {
					facts.attemptedEdits.set(path, order);
				}
			}
		} else if (message.role === "toolResult") {
			collectResult(message, calls, facts, order);
		}
		order++;
	}

	return facts;
}

function collectResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
	calls: Map<string, CallInfo>,
	facts: Facts,
	order: number,
): void {
	const call = calls.get(message.toolCallId);
	const name = message.toolName || call?.name || "";
	const text = contentText(message.content, "").trim();
	const path = pathOf(call?.arguments);

	for (const nested of message.nestedCalls?.calls ?? []) {
		const nestedPath = pathOf(nested.arguments);
		if (!nestedPath || (nested.name !== "write" && nested.name !== "edit")) continue;
		if (nested.status === "ok") {
			facts.edits.set(nestedPath, order);
			facts.failedEdits.delete(nestedPath);
		} else {
			facts.failedEdits.add(nestedPath);
			facts.attemptedEdits.delete(nestedPath);
		}
	}

	if (name === "read" && path && !message.isError && !isImageResult(message) && text) {
		if (READ_STATUS_PREFIXES.some((prefix) => text.startsWith(prefix))) return;
		const offset = Number(call?.arguments.offset) || 1;
		facts.reads.push({ path, content: text, order, offset });
		return;
	}

	if (name === "write" || name === "edit") {
		if (!path) return;
		if (message.isError) {
			facts.failedEdits.add(path);
			facts.attemptedEdits.delete(path);
		} else {
			facts.edits.set(path, order);
			facts.failedEdits.delete(path);
		}
		return;
	}

	if ((name === "bash" || name === "powershell") && call) {
		const command = stringArg(call.arguments, "command");
		if (command) {
			facts.commands.push({
				command,
				failed: message.isError,
				error: message.isError ? errorLine(text) : undefined,
			});
		}
		return;
	}

	if (/ask|question|confirm/i.test(name) && !message.isError && text) {
		facts.answers.push({ text });
	}
}

function lastEdit(facts: Facts, path: string): number {
	return Math.max(facts.edits.get(path) ?? -1, facts.attemptedEdits.get(path) ?? -1);
}

function render(facts: Facts, fileOps: FileOperations, maxChars: number): string {
	const sections: string[] = [];
	let used = 0;
	const append = (section: string): boolean => {
		if (used + section.length > maxChars) return false;
		sections.push(section);
		used += section.length;
		return true;
	};

	if (facts.requests.length > 0) {
		const lines = facts.requests
			.slice(-MAX_REQUESTS)
			.map((request) => `- ${truncateEnd(request.replace(/\s+/g, " "), REQUEST_MAX_CHARS)}`);
		append(`\n## Requests\n${lines.join("\n")}\n`);
	}

	const modified = [...new Set([...fileOps.edited, ...fileOps.written])].sort();
	const latest = new Map<string, ReadRecord>();
	for (const read of facts.reads) latest.set(read.path, read);
	const candidates = [...latest.values()].sort((a, b) => b.order - a.order);
	const fresh = new Set(
		candidates.filter((read) => lastEdit(facts, read.path) < read.order).map((read) => read.path),
	);

	if (modified.length > 0 || candidates.length > 0) {
		let files = "\n## Files\nSnapshot from the compaction point; re-read before editing.\n";
		for (const path of modified) {
			if (fresh.has(path)) continue;
			if (facts.failedEdits.has(path) && !facts.edits.has(path)) continue;
			files += `- ${path} (edited)\n`;
		}
		for (const read of candidates) {
			const editedAfter = lastEdit(facts, read.path) > read.order;
			if (!editedAfter) {
				const label = facts.edits.has(read.path)
					? `edited then read, ${lineLabel(read.content)}`
					: `read, ${lineLabel(read.content)}`;
				const block = formatFileBlock(read.path, read.content, label);
				if (used + files.length + block.length <= maxChars) {
					files += block;
					continue;
				}
			}
			const reason = editedAfter ? "edited after this read" : "excerpt omitted for space";
			const outline = formatOutlineBlock(read.path, read, reason);
			if (used + files.length + outline.length <= maxChars) {
				files += outline;
			} else if (used + files.length + `- ${read.path}\n`.length <= maxChars) {
				files += `- ${read.path}\n`;
			}
		}
		if (files.includes("\n- ")) append(files);
	}

	if (facts.commands.length > 0) {
		const lines = facts.commands.slice(-MAX_COMMANDS).map((command) => {
			const short = truncateEnd(command.command.replace(/\s+/g, " "), COMMAND_MAX_CHARS);
			return command.failed
				? `- \`${short}\` failed${command.error ? `: ${command.error}` : ""}`
				: `- \`${short}\` ok`;
		});
		append(`\n## Commands\n${lines.join("\n")}\n`);
	}

	if (facts.answers.length > 0) {
		const lines = facts.answers
			.slice(-MAX_ANSWERS)
			.map(
				(answer) => `- ${truncateMiddle(answer.text.replace(/\s+/g, " "), ANSWER_MAX_CHARS)}`,
			);
		append(`\n## Answers\n${lines.join("\n")}\n`);
	}

	return sections.join("");
}

export function buildCompactionMemory(input: {
	messages: AgentMessage[];
	fileOps: FileOperations;
	maxChars?: number;
}): string {
	const facts = collect(input.messages);
	return render(facts, input.fileOps, input.maxChars ?? MEMORY_MAX_CHARS);
}
