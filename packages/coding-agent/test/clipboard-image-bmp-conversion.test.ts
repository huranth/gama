import { describe, expect, test, vi } from "vitest";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";

function createTinyBmp1x1Red24bpp(): Uint8Array {
	const buffer = Buffer.alloc(58);

	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt16LE(0, 6);
	buffer.writeUInt16LE(0, 8);
	buffer.writeUInt32LE(54, 10);

	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer.writeInt32LE(0, 38);
	buffer.writeInt32LE(0, 42);
	buffer.writeUInt32LE(0, 46);
	buffer.writeUInt32LE(0, 50);

	buffer[54] = 0x00;
	buffer[55] = 0x00;
	buffer[56] = 0xff;
	buffer[57] = 0x00;

	return new Uint8Array(buffer);
}

vi.mock("../src/utils/clipboard-command.ts", () => ({
	runClipboardCommand: vi.fn(async (command: string, args: string[]) => {
		if (command === "wl-paste" && args.includes("--list-types"))
			return Buffer.from("image/bmp\n");
		if (command === "wl-paste" && args.includes("image/bmp"))
			return Buffer.from(createTinyBmp1x1Red24bpp());
		return undefined;
	}),
}));

vi.mock("@huranth/gama-tui", () => ({
	getNativeClipboard: () => ({ getImage: async () => createTinyBmp1x1Red24bpp() }),
}));

describe("readClipboardImage BMP conversion", () => {
	test.each(["linux", "win32"] as const)(
		"%s: converts command/native BMP to PNG",
		async (platform) => {
			const image = await readClipboardImage({
				env: { WAYLAND_DISPLAY: "wayland-0" },
				platform,
			});

			expect(image).not.toBeNull();
			expect(image!.mimeType).toBe("image/png");
			expect(Array.from(image!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
		},
	);
});
