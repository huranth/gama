import { describe, expect, it } from "vitest";
import { convertToPng, loadPngTranscoder } from "../src/utils/image-convert.ts";
import { formatDimensionNote, resizeImage } from "../src/utils/image-resize.ts";

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAA" +
		"XcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgA" +
		"AAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU" +
		"6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0V" +
		"DAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBY" +
		"QERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF" +
		"BQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAA" +
		"AAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VT" +
		"B3/2Q==";

const TINY_JPEG_2X1 =
	"/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAIDAREAAhEBAxEB/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAw" +
		"KDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUF" +
		"BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8Q" +
		"AtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0N" +
		"TY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i" +
		"5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcIC" +
		"QoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRo" +
		"mJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqs" +
		"rO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4H8Q/8h/Uv+vmX/0" +
		"M1/o1wJ/ySWU/9g1D/wBNRMOM/wDkp8z/AOv9b/05I//Z";

const MEDIUM_PNG_100x100 =
	"iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAAAAABVicqIAAAAAmJLR0QA/4ePzL8AAAAHdElNRQfqAQ4AMzkN2iH/AAAAP0l" +
		"EQVRo3u3NQQEAAAQEMASXXYrz2gqst/Lm4ZBIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiSTsAP1cAUZeKtreA" +
		"AAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAw6crMeAAAACV0RVh0ZGF0ZTptb2RpZnkAMjA" +
		"yNi0wMS0xNFQwMDo1MTo1NyswMDowMJiXdMQAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDEtMTRUMDA6NTE6NTcrM" +
		"DA6MDDPglUbAAAAAElFTkSuQmCC";

const LARGE_PNG_200x200 =
	"iVBORw0KGgoAAAANSUhEUgAAAMgAAADIEAIAAAByquWKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAA" +
		"XcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqAQ4AMzqU03BFAAAEEElEQVR42u3dvWqUURSF4XXMRAyIhSAWQ" +
		"vwnWtjaWusFx9bW1kKD/wELESxEiBjDjJdwysOC57mCXW32+zGcGbtdACpsdi+T8Xz1GABzm91xMl6sHgNgblzcT/Y+rh4" +
		"DYG6cv0/2H64eA2BOEgI1fHQHaoyzbXIwVo8BMCcJgRqSEKgxft9Lrn5aPQbA3Ph1klw7Wj0GwJwkBGpYWECN8fMiub63e" +
		"gyAORcWUMPCAmqMH3eTG59XjwEwN76/S24+Wj0GwJwkBGpYWECN8e1fcmuzegyAORcWUMPCAmqM09vJ4dfVYwDMjS9vkzu" +
		"PV48BMCcJgRqeSAZqjA/nyYP91WMAzElCoIYkBGqMk8Pk6HT1GABzm+3L5JIkBApIQqCGj+5AjfHmb/Lk8uoxAOYkIVBDE" +
		"gI1LCygxmZ7nFyShEABFxZQw8ICaozXf5KnV1aPATDnwgJqWFhADQsLqOFnDUANFxZQw8ICaoxXZ8mzg9VjAMy5sIAaFhZ" +
		"Qw3tYQA1/QgHUkIRADUkI1JCEQA1JCNSQhEANFxZQwzcsoIYkBGpIQqCGJARqSEKghiQEalhYQA1/QgHUcGEBNSwsoIYkB" +
		"Gq4sIAaFhZQw8ICaviGBdRwYQE1LCyghiQEariwgBoWFlDDe1hADS+OAjUkIVBDEgI1JCFQQxICNSQhUMOFBdTwDQuoIQm" +
		"BGpIQqCEJgRqSEKghCYEaFhZQw4ujQA0XFlDDwgJqSEKghgsLqGFhATUsLKCGb1hADRcWUMPCAmpIQqCGCwuoYWEBNbyHB" +
		"dTw4ihQQxICNSQhUEMSAjUkIVBDEgI1XFhADd+wgBqSEKghCYEakhCoIQmBGpIQqGFhATW8OArUcGEBNSwsoIYkBGq4sIA" +
		"aFhZQw8ICaviGBdRwYQE1LCyghiQEariwgBoWFlDDe1hADS+OAjUkIVBDEgI1JCFQQxICNSQhUMOFBdTwDQuoIQmBGpIQq" +
		"CEJgRqSEKghCYEa49lB8ups9RgAc14cBWpIQqCGhQXUkIRADRcWUMPCAmqMp1eS139WjwEw5xsWUEMSAjUsLKCGJARquLC" +
		"AGhYWUGM8uZy8+bt6DIA5L44CNSQhUMMTyUCNcXSanByuHgNgThICNSQhUGM82E8+nK8eA2DOzxqAGpIQqDHuPE6+vF09B" +
		"sDcOPyanN5ePQbAnCQEavgdFlBj3Nok3/6tHgNgzoujQA1JCNQYNx8l39+tHgNgbtz4nPy4u3oMgDlJCNSwsIAa4/pe8vN" +
		"i9RgAc37WANSQhECNce0o+XWyegyAuXH1U/L73uoxAOYkIVDDwgJqjIORnG1XjwEw508ogBqSEKgx9h8m5+9XjwEwN/Y+J" +
		"hf3V48BMCcJgRpjPE+2x6vHAJgbSbLbrR4DYO4/GqiSgXN+ksgAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDEtMTRUMDA" +
		"6NTE6NTcrMDA6MDDpysx4AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwmJd0xAAAACh0R" +
		"Vh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMM+CVRsAAAAASUVORK5CYII=";

function imageBytes(base64Data: string): Uint8Array {
	return Buffer.from(base64Data, "base64");
}

function app1Segment(payload: Uint8Array): Buffer {
	const segment = Buffer.alloc(payload.length + 4);
	segment[0] = 0xff;
	segment[1] = 0xe1;
	segment.writeUInt16BE(payload.length + 2, 2);
	segment.set(payload, 4);
	return segment;
}

function jpegWithXmpBeforeOrientation(): string {
	const jpeg = Buffer.from(TINY_JPEG_2X1, "base64");
	const xmp = app1Segment(
		Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'),
	);
	const orientation6 = app1Segment(
		Buffer.concat([
			Buffer.from("Exif\0\0"),
			Buffer.from("49492a0008000000010012010300010000000600000000000000", "hex"),
		]),
	);
	return Buffer.concat([jpeg.subarray(0, 2), xmp, orientation6, jpeg.subarray(2)]).toString(
		"base64",
	);
}

describe("convertToPng", () => {
	it("return original data for PNG input", async () => {
		const result = await convertToPng(TINY_PNG, "image/png");
		expect(result).not.toBeNull();
		expect(result!.data).toBe(TINY_PNG);
		expect(result!.mimeType).toBe("image/png");
	});

	it("convert JPEG to PNG", async () => {
		const result = await convertToPng(TINY_JPEG, "image/jpeg");
		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe("image/png");
		expect(() => Buffer.from(result!.data, "base64")).not.toThrow();
		const buffer = Buffer.from(result!.data, "base64");
		expect(buffer[0]).toBe(0x89);
		expect(buffer[1]).toBe(0x50);
		expect(buffer[2]).toBe(0x4e);
		expect(buffer[3]).toBe(0x47);
	});

	it("apply EXIF orientation after an XMP APP1 segment", async () => {
		const result = await convertToPng(jpegWithXmpBeforeOrientation(), "image/jpeg");

		expect(result).not.toBeNull();
		const png = Buffer.from(result!.data, "base64");
		expect(png.readUInt32BE(16)).toBe(1);
		expect(png.readUInt32BE(20)).toBe(2);
	});
});

it("loadPngTranscoder converts synchronously to oriented PNG data", async () => {
	const transcoder = (await loadPngTranscoder())!;
	const png = Buffer.from(transcoder(jpegWithXmpBeforeOrientation(), "image/jpeg")!, "base64");
	expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1, 2]);
	expect(transcoder(Buffer.from("not an image").toString("base64"), "image/jpeg")).toBeNull();
});

describe("resizeImage", () => {
	it("keep caller input bytes intact", async () => {
		const input = new Uint8Array(imageBytes(TINY_PNG));
		const originalByteLength = input.byteLength;
		const originalFirstByte = input[0];

		const result = await resizeImage(input, "image/png", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(input.byteLength).toBe(originalByteLength);
		expect(input[0]).toBe(originalFirstByte);
	});

	it("return original image if within limits", async () => {
		const result = await resizeImage(imageBytes(TINY_PNG), "image/png", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.data).toBe(TINY_PNG);
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
		expect(result!.width).toBe(2);
		expect(result!.height).toBe(2);
	});

	it("resize image exceeding dimension limits", async () => {
		const result = await resizeImage(imageBytes(MEDIUM_PNG_100x100), "image/png", {
			maxWidth: 50,
			maxHeight: 50,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(true);
		expect(result!.originalWidth).toBe(100);
		expect(result!.originalHeight).toBe(100);
		expect(result!.width).toBeLessThanOrEqual(50);
		expect(result!.height).toBeLessThanOrEqual(50);
	});

	it("resize image exceeding byte limit", async () => {
		const originalBuffer = Buffer.from(LARGE_PNG_200x200, "base64");
		const originalSize = originalBuffer.length;

		const result = await resizeImage(imageBytes(LARGE_PNG_200x200), "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: Math.floor(LARGE_PNG_200x200.length * 0.9),
		});

		expect(result).not.toBeNull();
		const resultBuffer = Buffer.from(result!.data, "base64");
		expect(resultBuffer.length).toBeLessThan(originalSize);
		expect(result!.data.length).toBeLessThan(LARGE_PNG_200x200.length);
	});

	it("return null when image cannot be resized below maxBytes", async () => {
		const result = await resizeImage(imageBytes(LARGE_PNG_200x200), "image/png", {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 1,
		});

		expect(result).toBeNull();
	});

	it("handle JPEG input", async () => {
		const result = await resizeImage(imageBytes(TINY_JPEG), "image/jpeg", {
			maxWidth: 100,
			maxHeight: 100,
			maxBytes: 1024 * 1024,
		});

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.originalWidth).toBe(2);
		expect(result!.originalHeight).toBe(2);
	});
});

describe("formatDimensionNote", () => {
	it("return undefined for non-resized images", () => {
		const note = formatDimensionNote({
			data: "",
			mimeType: "image/png",
			originalWidth: 100,
			originalHeight: 100,
			width: 100,
			height: 100,
			wasResized: false,
		});
		expect(note).toBeUndefined();
	});

	it("return formatted note for resized images", () => {
		const note = formatDimensionNote({
			data: "",
			mimeType: "image/png",
			originalWidth: 2000,
			originalHeight: 1000,
			width: 1000,
			height: 500,
			wasResized: true,
		});
		expect(note).toContain("original 2000x1000");
		expect(note).toContain("displayed at 1000x500");
		expect(note).toContain("2.00");
	});
});
