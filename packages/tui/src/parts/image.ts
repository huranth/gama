import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	getPngDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

let imageTranscoder: ImageTranscoder | undefined;

const pngCache = new Map<string, string | null>();

export type ImageTranscoder = (base64Data: string, mimeType: string) => string | null;

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	imageId?: number;
}

export function setImageTranscoder(transcoder: ImageTranscoder | undefined): void {
	imageTranscoder = transcoder;
	pngCache.clear();
}

function toPng(base64Data: string, mimeType: string): string | null {
	if (!imageTranscoder) return null;
	const cached = pngCache.get(base64Data);
	const png = cached === undefined ? imageTranscoder(base64Data, mimeType) : cached;
	pngCache.delete(base64Data);
	pngCache.set(base64Data, png);

	if (pngCache.size > 32) {
		pngCache.delete(pngCache.keys().next().value!);
	}

	return png;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;
	private pngData?: string;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions ||
			getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		const cellDimensions = getCellDimensions();
		const defaultMaxHeight = Math.max(
			1,
			Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx),
		);
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;

		const caps = getCapabilities();
		let data: string | null = this.base64Data;
		let dimensions = this.dimensions;

		if (caps.images === "kitty" && this.mimeType !== "image/png") {
			this.pngData ??= toPng(this.base64Data, this.mimeType) ?? undefined;
			data = this.pngData ?? null;

			if (data) {
				dimensions = getPngDimensions(data) ?? dimensions;
			}
		}

		let lines: string[];

		if (caps.images && data) {
			if (caps.images === "kitty" && this.imageId === undefined) {
				this.imageId = allocateImageId();
			}

			const result = renderImage(data, dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: maxHeight,
				imageId: this.imageId,
				moveCursor: false,
			});

			if (!result) {
				const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
				lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
			} else if (caps.images === "kitty") {
				if (result.imageId) {
					this.imageId = result.imageId;
				}

				lines = [result.sequence];

				for (let i = 0; i < result.rows - 1; i++) {
					lines.push("");
				}
			} else {
				const rowOffset = result.rows - 1;
				const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
				lines = [];

				for (let i = 0; i < rowOffset; i++) {
					lines.push("");
				}

				lines.push(moveUp + result.sequence);
			}
		} else {
			const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
			lines = [truncateToWidth(this.theme.fallbackColor(fallback), width)];
		}

		this.cachedLines = lines;
		this.cachedWidth = width;

		return lines;
	}
}
