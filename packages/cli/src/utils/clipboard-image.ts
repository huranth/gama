import { getNativeClipboard } from "@huranth/gama-tui";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runClipboardCommand } from "./clipboard-command.ts";
import { detectSupportedImageMimeType } from "./mime.ts";
import { loadPhoton } from "./photon.ts";
import { isWSL } from "./wsl.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const supportedImageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const defaultListTimeoutMs = 1000;

const defaultPowerShellTimeoutMs = 5000;

function baseMimeType(mimeType: string): string {
	const base = mimeType.split(";")[0]?.trim();
	return (base ?? mimeType).toLowerCase();
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return supportedImageMimeTypes.some((supported) => supported === base);
}

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";

		case "image/jpeg":
			return "jpg";

		case "image/webp":
			return "webp";

		case "image/gif":
			return "gif";

		default:
			return null;
	}
}

function parseMimeList(bytes: Buffer): string[] {
	return bytes
		.toString("utf-8")
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter(Boolean);
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((raw) => raw.trim())
		.filter(Boolean)
		.map((raw) => ({ raw, base: baseMimeType(raw) }));

	for (const preferred of supportedImageMimeTypes) {
		const match = normalized.find((entry) => entry.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((entry) => entry.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) return null;

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);

		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

async function readClipboardImageFrom(
	command: string,
	listArgs: string[],
	dataArgs: (mimeType: string) => string[],
): Promise<ClipboardImage | null | undefined> {
	const list = await runClipboardCommand(command, listArgs, { timeoutMs: defaultListTimeoutMs });
	if (list === undefined) return undefined;

	const selectedType = selectPreferredImageMimeType(parseMimeList(list));
	if (!selectedType) return null;

	const data = await runClipboardCommand(command, dataArgs(selectedType));
	if (data === undefined) return undefined;
	if (data.length === 0) return null;

	return { bytes: data, mimeType: baseMimeType(selectedType) };
}

function readClipboardImageViaWlPaste(): Promise<ClipboardImage | null | undefined> {
	const dataArgs = (mimeType: string) => ["--type", mimeType, "--no-newline"];
	return readClipboardImageFrom("wl-paste", ["--list-types"], dataArgs);
}

function readClipboardImageViaXclip(): Promise<ClipboardImage | null | undefined> {
	const dataArgs = (mimeType: string) => ["-selection", "clipboard", "-t", mimeType, "-o"];
	return readClipboardImageFrom(
		"xclip",
		["-selection", "clipboard", "-t", "TARGETS", "-o"],
		dataArgs,
	);
}

async function readClipboardImageViaPowerShell(): Promise<ClipboardImage | null> {
	const tmpFile = join(tmpdir(), `gama-wsl-clip-${randomUUID()}.png`);

	try {
		const winPathResult = await runClipboardCommand("wslpath", ["-w", tmpFile], {
			timeoutMs: defaultListTimeoutMs,
		});
		if (winPathResult === undefined) {
			return null;
		}

		const winPath = winPathResult.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		const quotedPath = winPath.replaceAll("'", "''");
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${quotedPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); " +
				"Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = await runClipboardCommand(
			"powershell.exe",
			["-NoProfile", "-Command", script],
			{ timeoutMs: defaultPowerShellTimeoutMs },
		);
		if (result === undefined) {
			return null;
		}

		const output = result.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
	}
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null | undefined> {
	const bytes = await getNativeClipboard()?.getImage();
	if (bytes === undefined) return undefined;
	if (!bytes?.length) return null;

	const mimeType = detectSupportedImageMimeType(bytes) ?? "application/octet-stream";
	return { bytes, mimeType };
}

async function readLinuxClipboardImage(
	env: NodeJS.ProcessEnv,
): Promise<ClipboardImage | null | undefined> {
	const wsl = isWSL(env);
	const hasWayland = isWaylandSession(env);
	let image: ClipboardImage | null | undefined;

	if (hasWayland || wsl) image = await readClipboardImageViaWlPaste();
	if (image === undefined) image = await readClipboardImageViaXclip();
	if (!image && wsl) image = (await readClipboardImageViaPowerShell()) ?? image;
	if (image === undefined) image = await readClipboardImageViaNativeClipboard();

	return image;
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	const image =
		platform === "linux"
			? await readLinuxClipboardImage(env)
			: await readClipboardImageViaNativeClipboard();

	if (!image) return null;
	if (isSupportedImageMimeType(image.mimeType)) return image;

	const pngBytes = await convertToPng(image.bytes);
	if (!pngBytes) return null;

	return { bytes: pngBytes, mimeType: "image/png" };
}
