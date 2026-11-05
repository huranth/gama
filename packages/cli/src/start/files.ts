import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@huranth/gama-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	autoResizeImages?: boolean;
	cwd?: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
	console.error(chalk.red(`Error: ${message}`));
	process.exit(1);
}

function fileBlock(path: string, body: string): string {
	return `<file name="${path}">${body}</file>\n`;
}

export async function processFileArguments(
	fileArgs: string[],
	options?: ProcessFileOptions,
): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const cwd = options?.cwd ?? process.cwd();
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		const absolutePath = resolve(resolveReadPath(fileArg, cwd));

		try {
			await access(absolutePath);
		} catch {
			fail(`File not found: ${absolutePath}`);
		}

		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(absolutePath);
		} catch (error: unknown) {
			fail(`Read failed: ${absolutePath}: ${messageOf(error)}`);
		}

		if (stats.isDirectory()) {
			fail(`File is directory: ${absolutePath}`);
		}

		if (stats.size === 0) {
			text += fileBlock(absolutePath, "\n\n");
			continue;
		}

		let mimeType: string | null;
		try {
			mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
		} catch (error: unknown) {
			fail(`Read failed: ${absolutePath}: ${messageOf(error)}`);
		}

		if (mimeType) {
			try {
				const content = await readFile(absolutePath);
				const processed = await processImage(content, mimeType, { autoResizeImages });

				if (!processed.ok) {
					text += fileBlock(absolutePath, processed.message);
					continue;
				}

				const attachment: ImageContent = {
					type: "image",
					mimeType: processed.mimeType,
					data: processed.data,
				};

				images.push(attachment);
				text += fileBlock(absolutePath, processed.hints.join("\n"));
			} catch (error: unknown) {
				fail(`Read failed: ${absolutePath}: ${messageOf(error)}`);
			}
		} else {
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				text += fileBlock(absolutePath, `\n${content}\n`);
			} catch (error: unknown) {
				fail(`Read failed: ${absolutePath}: ${messageOf(error)}`);
			}
		}
	}

	return { text, images };
}
