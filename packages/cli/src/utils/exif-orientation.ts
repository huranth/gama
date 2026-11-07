import type { PhotonImageType } from "./photon.ts";

type Photon = typeof import("@silvia-odwyer/photon-node");

type DstIndexFn = (x: number, y: number, w: number, h: number) => number;

const exifMarker = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

const littleEndianTag = 0x4949;

const orientationTag = 0x0112;

const ifdEntryLength = 12;

const maxOrientation = 8;

function startsWithBytes(bytes: Uint8Array, offset: number, expected: number[]): boolean {
	if (offset + expected.length > bytes.length) return false;
	return expected.every((value, index) => bytes[offset + index] === value);
}

function isJpeg(bytes: Uint8Array): boolean {
	return startsWithBytes(bytes, 0, [0xff, 0xd8]);
}

function isWebp(bytes: Uint8Array): boolean {
	const riff = startsWithBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]);
	const webp = startsWithBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50]);
	return riff && webp;
}

function getExifOrientation(bytes: Uint8Array): number {
	let tiffOffset = -1;

	if (isJpeg(bytes)) tiffOffset = findJpegTiffOffset(bytes);
	else if (isWebp(bytes)) tiffOffset = findWebpTiffOffset(bytes);

	if (tiffOffset === -1) return 1;
	return readOrientationFromTiff(bytes, tiffOffset);
}

function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
	return exifMarker.every((value, index) => bytes[offset + index] === value);
}

function findJpegTiffOffset(bytes: Uint8Array): number {
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) return -1;

		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}

		if (marker === 0xe1) {
			if (offset + 4 >= bytes.length) return -1;

			const segmentStart = offset + 4;
			if (segmentStart + 6 > bytes.length) return -1;
			if (hasExifHeader(bytes, segmentStart)) return segmentStart + 6;
		}

		if (offset + 4 > bytes.length) return -1;

		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		offset += 2 + length;
	}

	return -1;
}

function findWebpTiffOffset(bytes: Uint8Array): number {
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunkId = String.fromCharCode(
			bytes[offset],
			bytes[offset + 1],
			bytes[offset + 2],
			bytes[offset + 3],
		);
		const chunkSize =
			bytes[offset + 4] |
			(bytes[offset + 5] << 8) |
			(bytes[offset + 6] << 16) |
			(bytes[offset + 7] << 24);
		const dataStart = offset + 8;

		if (chunkId === "EXIF") {
			if (dataStart + chunkSize > bytes.length) return -1;

			const hasHeader = chunkSize >= 6 && hasExifHeader(bytes, dataStart);
			return hasHeader ? dataStart + 6 : dataStart;
		}

		offset = dataStart + chunkSize + (chunkSize % 2);
	}

	return -1;
}

function read16(bytes: Uint8Array, pos: number, littleEndian: boolean): number {
	if (littleEndian) return bytes[pos] | (bytes[pos + 1] << 8);
	return (bytes[pos] << 8) | bytes[pos + 1];
}

function read32(bytes: Uint8Array, pos: number, littleEndian: boolean): number {
	if (littleEndian) {
		const value =
			bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
		return value;
	}

	const bigEndian =
		(bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
	return bigEndian >>> 0;
}

function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
	if (tiffStart + 8 > bytes.length) return 1;

	const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1];
	const littleEndian = byteOrder === littleEndianTag;

	const ifdOffset = read32(bytes, tiffStart + 4, littleEndian);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdStart + 2 > bytes.length) return 1;

	const entryCount = read16(bytes, ifdStart, littleEndian);
	for (let i = 0; i < entryCount; i++) {
		const entryPos = ifdStart + 2 + i * ifdEntryLength;
		if (entryPos + ifdEntryLength > bytes.length) return 1;

		if (read16(bytes, entryPos, littleEndian) === orientationTag) {
			const value = read16(bytes, entryPos + 8, littleEndian);
			return value >= 1 && value <= maxOrientation ? value : 1;
		}
	}

	return 1;
}

function rotate90(photon: Photon, image: PhotonImageType, dstIndex: DstIndexFn): PhotonImageType {
	const width = image.get_width();
	const height = image.get_height();
	const source = image.get_raw_pixels();
	const rotated = new Uint8Array(source.length);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sourceIndex = (y * width + x) * 4;
			const targetIndex = dstIndex(x, y, width, height) * 4;

			rotated[targetIndex] = source[sourceIndex];
			rotated[targetIndex + 1] = source[sourceIndex + 1];
			rotated[targetIndex + 2] = source[sourceIndex + 2];
			rotated[targetIndex + 3] = source[sourceIndex + 3];
		}
	}

	return new photon.PhotonImage(rotated, height, width);
}

export function applyExifOrientation(
	photon: Photon,
	image: PhotonImageType,
	originalBytes: Uint8Array,
): PhotonImageType {
	const orientation = getExifOrientation(originalBytes);
	if (orientation === 1) return image;

	switch (orientation) {
		case 2:
			photon.fliph(image);
			return image;

		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;

		case 4:
			photon.flipv(image);
			return image;

		case 5: {
			const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}

		case 6:
			return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));

		case 7: {
			const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}

		case 8:
			return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);

		default:
			return image;
	}
}
