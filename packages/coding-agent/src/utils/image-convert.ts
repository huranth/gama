import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@huranth/gama-tui";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

let pngTranscoderLoad: Promise<boolean> | undefined;

let pngTranscoderRegistered = false;

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) return null;
	return encodePng(photon, bytes);
}

export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	if (mimeType === "image/png") return { data: base64Data, mimeType };

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) return null;

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}

export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	const photon = await loadPhoton();
	if (!photon) return undefined;
	return (base64Data) => {
		const pngBytes = encodePng(photon, new Uint8Array(Buffer.from(base64Data, "base64")));
		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

export function ensurePngTranscoder(onRegistered: () => void): void {
	if (pngTranscoderRegistered) return;
	if (getCapabilities().images !== "kitty") return;
	pngTranscoderLoad ??= loadPngTranscoder().then((transcoder) => {
		if (!transcoder) return false;
		setImageTranscoder(transcoder);
		pngTranscoderRegistered = true;
		return true;
	});
	void pngTranscoderLoad.then((registered) => {
		if (registered) onRegistered();
	});
}
