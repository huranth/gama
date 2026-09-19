import type { AgentMessage } from "@huranth/gama-agent-core";
import type { ImageContent, Message, TextContent } from "@huranth/gama-ai";
import { commandExitStatus } from "./exit-code.ts";
import { frameSteeringContent, frameSteeringText } from "./steering.ts";

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following " +
	`summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX =
	"The following is a summary of a branch that this conversation came back " +
	`from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

declare module "@huranth/gama-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

function parseMessageTimestamp(value: string): number {
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : Date.now();
}

export function createBranchSummaryMessage(
	summary: string,
	fromId: string,
	timestamp: string,
): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: parseMessageTimestamp(timestamp),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: parseMessageTimestamp(timestamp),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: parseMessageTimestamp(timestamp),
	};
}

export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	text += msg.output ? `\`\`\`\n${msg.output}\n\`\`\`` : "No output";

	if (msg.cancelled) {
		text += "\n\nCommand cancelled";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\n${commandExitStatus(msg.exitCode)}`;
	}

	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\nOutput truncated, full output at ${msg.fullOutputPath}`;
	}

	return text;
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
	const converted: Message[] = [];

	for (const message of messages) {
		const result = convertMessage(message);
		if (result) converted.push(result);
	}

	return converted;
}

function convertMessage(message: AgentMessage): Message | undefined {
	switch (message.role) {
		case "bashExecution":
			if (message.excludeFromContext) return undefined;

			return {
				role: "user",
				content: [{ type: "text", text: bashExecutionToText(message) }],
				timestamp: message.timestamp,
			};
		case "custom":
			return {
				role: "user",
				content: toTextContent(message.content),
				timestamp: message.timestamp,
			};
		case "branchSummary":
			return {
				role: "user",
				content: [
					{
						type: "text",
						text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
					},
				],
				timestamp: message.timestamp,
			};
		case "compactionSummary":
			return {
				role: "user",
				content: [
					{
						type: "text",
						text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
					},
				],
				timestamp: message.timestamp,
			};
		case "user": {
			if (!message.steering) return message;

			const content =
				typeof message.content === "string"
					? frameSteeringText(message.content)
					: frameSteeringContent(message.content);

			return { ...message, content };
		}
		case "system":
		case "assistant":
		case "toolResult":
			return message;
		default: {
			const unreachable: never = message;
			return unreachable;
		}
	}
}

function toTextContent(
	content: string | (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	return content;
}
