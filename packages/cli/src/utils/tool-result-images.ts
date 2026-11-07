import type { ImageContent, ModelImageResizeOptions, TextContent } from "@huranth/gama-ai";
import { processImage } from "./image-process.ts";

export type ToolResultContent = TextContent | ImageContent;

export interface NormalizeToolResultImagesOptions {
	autoResizeImages?: boolean;
	resizeOptions?: ModelImageResizeOptions;
}

type ImageBlock = Extract<ToolResultContent, { type: "image" }>;

async function normalizeImageBlock(
	block: ImageBlock,
	options: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[] | undefined> {
	const processed = await processImage(Buffer.from(block.data, "base64"), block.mimeType, {
		autoResizeImages: options.autoResizeImages ?? true,
		resizeOptions: options.resizeOptions,
	});
	if (!processed.ok) return undefined;

	const isUnchanged =
		processed.data === block.data &&
		processed.mimeType === block.mimeType &&
		processed.hints.length === 0;
	if (isUnchanged) return undefined;

	const normalized: ToolResultContent[] = [
		{ type: "image", data: processed.data, mimeType: processed.mimeType },
	];
	if (processed.hints.length > 0) {
		normalized.push({ type: "text", text: processed.hints.join("\n") });
	}

	return normalized;
}

export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	if (!content.some((block) => block.type === "image")) {
		return content;
	}

	const resolvedOptions = options ?? {};
	const normalized: ToolResultContent[] = [];
	let changed = false;

	for (const block of content) {
		const replacement =
			block.type === "image" ? await normalizeImageBlock(block, resolvedOptions) : undefined;
		if (!replacement) {
			normalized.push(block);
			continue;
		}

		normalized.push(...replacement);
		changed = true;
	}

	return changed ? normalized : content;
}
