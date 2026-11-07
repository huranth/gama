import { open } from "node:fs/promises";

const imageSniffBytes = 4100;

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const jpegSignature = [0xff, 0xd8, 0xff];

const jpegLsMarker = 0xf7;

const bmpBitDepths = [1, 4, 8, 16, 24, 32];

const pngMinBytes = 16;

const pngHeaderLength = 13;

const pngChunkOverhead = 8;

const pngChunkCrc = 4;

const pngChunkTypeDelta = 4;

const pngHeaderTypeOffset = 12;

const bmpMinBytes = 26;

const bmpCoreHeaderSize = 12;

const bmpInfoHeaderMin = 40;

const bmpInfoHeaderMax = 124;

const bmpInfoHeaderFixed = 30;

const bmpFileSizeOffset = 2;

const bmpPixelOffset = 10;

const bmpDibHeaderOffset = 14;

const bmpCorePlanesOffset = 22;

const bmpCoreDepthOffset = 24;

const bmpInfoPlanesOffset = 26;

const bmpInfoDepthOffset = 28;

const expectedColorPlanes = 1;

const highByte = 0x1000000;

function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * highByte
	);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * highByte +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}

	return true;
}

function isPng(buffer: Uint8Array): boolean {
	if (buffer.length < pngMinBytes) return false;
	if (readUint32BE(buffer, pngSignature.length) !== pngHeaderLength) return false;
	return startsWithAscii(buffer, pngHeaderTypeOffset, "IHDR");
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = pngSignature.length;
	while (offset + pngChunkOverhead <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + pngChunkTypeDelta;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		const nextOffset = offset + pngChunkOverhead + chunkLength + pngChunkCrc;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}

	return false;
}

function isBmp(buffer: Uint8Array): boolean {
	if (buffer.length < bmpMinBytes) return false;

	const declaredFileSize = readUint32LE(buffer, bmpFileSizeOffset);
	const pixelDataOffset = readUint32LE(buffer, bmpPixelOffset);
	const dibHeaderSize = readUint32LE(buffer, bmpDibHeaderOffset);

	if (declaredFileSize !== 0 && declaredFileSize < bmpMinBytes) return false;
	if (pixelDataOffset < bmpDibHeaderOffset + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	return hasValidBmpHeader(buffer, dibHeaderSize);
}

function hasValidBmpHeader(buffer: Uint8Array, dibHeaderSize: number): boolean {
	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === bmpCoreHeaderSize) {
		colorPlanes = readUint16LE(buffer, bmpCorePlanesOffset);
		bitsPerPixel = readUint16LE(buffer, bmpCoreDepthOffset);
	} else if (dibHeaderSize >= bmpInfoHeaderMin && dibHeaderSize <= bmpInfoHeaderMax) {
		if (buffer.length < bmpInfoHeaderFixed) return false;
		colorPlanes = readUint16LE(buffer, bmpInfoPlanesOffset);
		bitsPerPixel = readUint16LE(buffer, bmpInfoDepthOffset);
	} else {
		return false;
	}

	return colorPlanes === expectedColorPlanes && bmpBitDepths.includes(bitsPerPixel);
}

export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, jpegSignature)) {
		return buffer[3] === jpegLsMarker ? null : "image/jpeg";
	}

	if (startsWith(buffer, pngSignature)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}

	if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) {
		return "image/gif";
	}

	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}

	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}

	return null;
}

export async function detectSupportedImageMimeTypeFromFile(
	filePath: string,
): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(imageSniffBytes);
		const { bytesRead } = await fileHandle.read(buffer, 0, imageSniffBytes, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}
