import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
	const free = vi.fn();
	const rawImage = { free };
	const photon = {
		PhotonImage: { new_from_byteslice: vi.fn(() => rawImage) },
	};

	return { free, rawImage, photon };
});

vi.mock("../src/utils/photon.ts", () => ({
	loadPhoton: vi.fn(async () => mock.photon),
}));

vi.mock("../src/utils/exif-orientation.ts", () => ({
	applyExifOrientation: vi.fn(() => {
		throw new Error("bad exif");
	}),
}));

import { convertImageBytesToPng } from "../src/utils/image-convert.ts";
import { resizeImageInProcess } from "../src/utils/image-resize-core.ts";

describe("image cleanup", () => {
	it("frees the raw image when EXIF handling throws", async () => {
		mock.free.mockClear();
		expect(await convertImageBytesToPng(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(mock.free).toHaveBeenCalledTimes(1);

		mock.free.mockClear();
		expect(await resizeImageInProcess(new Uint8Array([1, 2, 3]), "image/png")).toBeNull();
		expect(mock.free).toHaveBeenCalledTimes(1);
	});
});
