import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	maxBytes?: number;
	jpegQuality?: number;
}

export interface ResizedImage {
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

interface Size {
	width: number;
	height: number;
}

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

type PhotonImage = ReturnType<Photon["PhotonImage"]["new_from_byteslice"]>;

const defaultMaxBytes = 4.5 * 1024 * 1024;

const defaultOptions: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: defaultMaxBytes,
	jpegQuality: 80,
};

const jpegQualitySteps = [85, 70, 55, 40];

const shrinkFactor = 0.75;

function shrinkDimension(value: number): number {
	return Math.max(1, Math.floor(value * shrinkFactor));
}

function fitWithin(size: Size, maxWidth: number, maxHeight: number): Size {
	let width = size.width;
	let height = size.height;

	if (width > maxWidth) {
		height = Math.round((height * maxWidth) / width);
		width = maxWidth;
	}

	if (height > maxHeight) {
		width = Math.round((width * maxHeight) / height);
		height = maxHeight;
	}

	return { width, height };
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");

	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

function encodeCandidates(
	photon: Photon,
	source: PhotonImage,
	size: Size,
	jpegQualities: number[],
): EncodedCandidate[] {
	const filter = photon.SamplingFilter.Lanczos3;
	const resized = photon.resize(source, size.width, size.height, filter);

	try {
		const candidates = [encodeCandidate(resized.get_bytes(), "image/png")];

		for (const quality of jpegQualities) {
			const jpegBuffer = resized.get_bytes_jpeg(quality);
			candidates.push(encodeCandidate(jpegBuffer, "image/jpeg"));
		}

		return candidates;
	} finally {
		resized.free();
	}
}

export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...defaultOptions, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) return null;

	let image: PhotonImage | undefined;
	let rawImage: PhotonImage | undefined;
	try {
		rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();
		rawImage = undefined;

		const source = image;
		const originalWidth = source.get_width();
		const originalHeight = source.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		const widthFits = originalWidth <= opts.maxWidth;
		const heightFits = originalHeight <= opts.maxHeight;
		const sizeFits = inputBase64Size < opts.maxBytes;

		if (widthFits && heightFits && sizeFits) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		const target = fitWithin(
			{ width: originalWidth, height: originalHeight },
			opts.maxWidth,
			opts.maxHeight,
		);
		const qualities = Array.from(new Set([opts.jpegQuality, ...jpegQualitySteps]));

		let current = target;
		while (true) {
			const candidates = encodeCandidates(photon, source, current, qualities);

			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: current.width,
						height: current.height,
						wasResized: true,
					};
				}
			}

			if (current.width === 1 && current.height === 1) break;

			const next = {
				width: shrinkDimension(current.width),
				height: shrinkDimension(current.height),
			};
			const unchanged = next.width === current.width && next.height === current.height;
			if (unchanged) break;

			current = next;
		}

		return null;
	} catch {
		return null;
	} finally {
		rawImage?.free();
		if (image) {
			image.free();
		}
	}
}
