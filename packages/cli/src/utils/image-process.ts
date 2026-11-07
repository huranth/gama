import { convertImageBytesToPng } from "./image-convert.ts";
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "./image-resize.ts";

const pngMime = "image/png";

const jpegMime = "image/jpeg";

const gifMime = "image/gif";

const webpMime = "image/webp";

export interface ProcessImageOptions {
	autoResizeImages?: boolean;
	resizeOptions?: ImageResizeOptions;
}

export type ProcessImageResult =
	| {
			ok: true;
			data: string;
			mimeType: string;
			hints: string[];
		}
	| {
			ok: false;
			message: string;
		};

interface NormalizedImage {
	bytes: Uint8Array;
	mimeType: string;
	convertedFrom?: string;
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function unsupportedImageMessage(): string {
	return "[Image omitted: could not be converted to a supported inline image format.]";
}

function oversizedImageMessage(): string {
	return "[Image omitted: could not be resized below the inline image size limit.]";
}

function supportedMime(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case pngMime:
			return pngMime;

		case jpegMime:
		case "image/jpg":
			return jpegMime;

		case gifMime:
			return gifMime;

		case webpMime:
			return webpMime;

		default:
			return null;
	}
}

async function normalizeImage(
	bytes: Uint8Array,
	mimeType: string,
): Promise<NormalizedImage | null> {
	const normalizedMimeType = supportedMime(mimeType);
	if (normalizedMimeType) return { bytes, mimeType: normalizedMimeType };

	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) return null;

	return {
		bytes: pngBytes,
		mimeType: pngMime,
		convertedFrom: baseMimeType(mimeType),
	};
}

function conversionHints(from: string | undefined, to: string): string[] {
	if (!from || from === to) return [];

	return [`[Image converted from ${from} to ${to}.]`];
}

export async function processImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
	const autoResizeImages = options?.autoResizeImages ?? true;

	const normalized = await normalizeImage(bytes, mimeType);
	if (!normalized) {
		return { ok: false, message: unsupportedImageMessage() };
	}

	if (autoResizeImages) {
		const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);
		if (!resized) {
			return { ok: false, message: oversizedImageMessage() };
		}

		const hints = conversionHints(normalized.convertedFrom, resized.mimeType);

		const dimensionNote = formatDimensionNote(resized);
		if (dimensionNote) hints.push(dimensionNote);

		return {
			ok: true,
			data: resized.data,
			mimeType: resized.mimeType,
			hints,
		};
	}

	const hints = conversionHints(normalized.convertedFrom, normalized.mimeType);

	return {
		ok: true,
		data: Buffer.from(normalized.bytes).toString("base64"),
		mimeType: normalized.mimeType,
		hints,
	};
}
