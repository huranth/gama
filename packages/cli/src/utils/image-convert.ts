import { getCapabilities, type ImageTranscoder, setImageTranscoder } from "@huranth/gama-tui";
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

const pngMime = "image/png";

let transcoderPromise: Promise<boolean> | undefined;

let transcoderReady = false;

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	let rawImage: ReturnType<Photon["PhotonImage"]["new_from_byteslice"]> | undefined;
	try {
		rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		rawImage = undefined;

		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		return null;
	} finally {
		rawImage?.free();
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
	if (mimeType === pngMime) return { data: base64Data, mimeType };

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) return null;

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: pngMime,
	};
}

export async function loadPngTranscoder(): Promise<ImageTranscoder | undefined> {
	const photon = await loadPhoton();
	if (!photon) return undefined;

	return (base64Data) => {
		const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
		const pngBytes = encodePng(photon, bytes);

		return pngBytes ? Buffer.from(pngBytes).toString("base64") : null;
	};
}

async function registerPngTranscoder(): Promise<boolean> {
	const transcoder = await loadPngTranscoder();
	if (!transcoder) return false;

	setImageTranscoder(transcoder);
	transcoderReady = true;
	return true;
}

export function ensurePngTranscoder(onRegistered: () => void): void {
	if (transcoderReady) return;
	if (getCapabilities().images !== "kitty") return;

	transcoderPromise ??= registerPngTranscoder();
	void transcoderPromise
		.then((ready) => {
			if (ready) onRegistered();
		})
		.catch(() => {
			transcoderPromise = undefined;
		});
}
