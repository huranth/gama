import { readFileSync } from "node:fs";
import type { ImageContent, TextContent } from "@huranth/gama-ai/compat";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { processImage, type ProcessImageOptions } from "../../utils/image-process.ts";
import type { InputEventResult, InputSource } from "../ext/index.ts";
import type { Skill } from "../skills.ts";

export const SKILL_COMMAND_PREFIX = "/skill:";

export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

export interface ParsedCommand {
	name: string;
	args: string;
}

export interface ParsedSkillCommand {
	name: string;
	args: string;
}

export interface SkillExpansionContext {
	skills: Skill[];
	emitError(error: { extensionPath: string; event: string; error: string }): void;
}

export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(
		/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
	);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

export function parseCommand(text: string): ParsedCommand {
	const spaceIndex = text.indexOf(" ");
	return {
		name: spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex),
		args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1),
	};
}

export function parseSkillCommand(text: string): ParsedSkillCommand | null {
	if (!text.startsWith(SKILL_COMMAND_PREFIX)) return null;

	const spaceIndex = text.indexOf(" ");
	const prefixLength = SKILL_COMMAND_PREFIX.length;
	return {
		name: spaceIndex === -1 ? text.slice(prefixLength) : text.slice(prefixLength, spaceIndex),
		args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim(),
	};
}

export function expandSkillCommand(text: string, context: SkillExpansionContext): string {
	const command = parseSkillCommand(text);
	if (!command) return text;

	const skill = context.skills.find((item) => item.name === command.name);
	if (!skill) return text;

	try {
		const content = readFileSync(skill.filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const skillBlock =
			`<skill name="${skill.name}" location="${skill.filePath}">\n` +
			`References are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return command.args ? `${skillBlock}\n\n${command.args}` : skillBlock;
	} catch (error) {
		context.emitError({
			extensionPath: skill.filePath,
			event: "skill_expansion",
			error: error instanceof Error ? error.message : String(error),
		});
		return text;
	}
}

export function parsePromptContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images: ImageContent[] | undefined;
} {
	if (typeof content === "string") {
		return { text: content, images: undefined };
	}

	const textParts: string[] = [];
	const images: ImageContent[] = [];
	for (const part of content) {
		if (part.type === "text") {
			textParts.push(part.text);
		} else {
			images.push(part);
		}
	}

	return {
		text: textParts.join("\n"),
		images: images.length === 0 ? undefined : images,
	};
}

export function normalizePromptSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;

	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

export function normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) {
		return [];
	}

	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}

	return Array.from(unique);
}

export interface InputHandlerContext {
	hasHandlers(type: string): boolean;
	emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult>;
}

export async function runInputHandlers(
	context: InputHandlerContext,
	text: string,
	images: ImageContent[] | undefined,
	source: InputSource,
	streamingBehavior?: "steer" | "followUp",
): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
	if (!context.hasHandlers("input")) {
		return { text, images };
	}

	const inputResult = await context.emitInput(text, images, source, streamingBehavior);
	if (inputResult.action === "handled") {
		return undefined;
	}
	if (inputResult.action === "transform") {
		return { text: inputResult.text, images: inputResult.images ?? images };
	}
	return { text, images };
}

export interface PromptImageContext {
	getAutoResizeImages(): boolean;
	getResizeOptions(): ProcessImageOptions["resizeOptions"];
}

export async function normalizePromptImages(
	images: ImageContent[] | undefined,
	context: PromptImageContext,
): Promise<{ images: ImageContent[]; hints: string[] }> {
	if (!images) return { images: [], hints: [] };

	const normalizedImages: ImageContent[] = [];
	const hints: string[] = [];
	for (const image of images) {
		const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
			autoResizeImages: context.getAutoResizeImages(),
			resizeOptions: context.getResizeOptions(),
		});
		if (!processed.ok) {
			hints.push(processed.message);
			continue;
		}
		normalizedImages.push({
			type: "image",
			data: processed.data,
			mimeType: processed.mimeType,
		});
		hints.push(...processed.hints);
	}
	return { images: normalizedImages, hints };
}
