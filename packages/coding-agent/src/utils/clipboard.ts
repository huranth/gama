import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@huranth/gama-tui";
import { runClipboardCommand } from "./clipboard-command.ts";
import { isWSL } from "./wsl.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return false;
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

export async function readClipboardFilePaths(): Promise<string[] | null> {
	const paths = await getNativeClipboard()?.getFilePaths?.();
	return paths?.length ? paths : null;
}

async function copyViaWindowsClipboard(text: string): Promise<boolean> {
	const tmpFile = join(tmpdir(), `gama-wsl-clip-${randomUUID()}.txt`);
	try {
		writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });
		const winPathResult = await runClipboardCommand("wslpath", ["-w", tmpFile], {
			timeoutMs: 1000,
		});
		const winPath = winPathResult?.toString("utf8").trim();
		if (!winPath) return false;
		const escapedPath = winPath.replaceAll("'", "''");
		const script =
			`Set-Clipboard -Value ([System.IO.File]::ReadAllText('${escapedPath}', ` +
			`[System.Text.Encoding]::UTF8))`;
		const result = await runClipboardCommand(
			"powershell.exe",
			["-NoProfile", "-Command", script],
			{ timeoutMs: 5000 },
		);
		return result !== undefined;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {}
	}
}

export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux") {
		const commands: [string, string[]][] = [];
		if (process.env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
		if (process.env.WAYLAND_DISPLAY) {
			commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
		}
		if (process.env.DISPLAY) {
			commands.push(
				["xclip", ["-selection", "clipboard", "-out"]],
				["xsel", ["--clipboard", "--output"]],
			);
		}
		for (const [command, args] of commands) {
			const bytes = await runClipboardCommand(command, args, { timeoutMs: 5000 });
			if (bytes !== undefined) return bytes.toString("utf8") || null;
		}
	}
	try {
		return (await getNativeClipboard()?.getText()) || null;
	} catch {
		return null;
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	const p = platform();
	const env = process.env;
	let copied = false;
	if (p !== "linux") {
		try {
			const clipboard = getNativeClipboard();
			if (clipboard?.setText) {
				await clipboard.setText(text);
				copied = true;
			}
		} catch {}
	}
	if (!copied) {
		const commands: [string, string[]][] = [];
		if (p === "darwin") commands.push(["pbcopy", []]);
		else if (p === "win32") commands.push(["clip", []]);
		else {
			if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
			if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
			if (env.DISPLAY) {
				commands.push(
					["xclip", ["-selection", "clipboard"]],
					["xsel", ["--clipboard", "--input"]],
				);
			}
		}
		for (const [command, args] of commands) {
			const result = await runClipboardCommand(command, args, { input: text, timeoutMs: 5000 });
			if (result === undefined) continue;
			copied = true;
			break;
		}
	}
	let osc52Emitted = false;
	if (!copied && p === "linux" && isWSL(env)) {
		if (env.WT_SESSION) osc52Emitted = emitOsc52(text);
		copied = osc52Emitted || (await copyViaWindowsClipboard(text));
	}
	const noDisplay = !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	const headless = p === "linux" && noDisplay;
	const needsOsc52 = isRemoteSession(env) || (!copied && headless);
	let oversized = false;
	if (!osc52Emitted && needsOsc52) {
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}
	if (copied) return;
	if (oversized) {
		throw new Error("Clipboard unavailable: text exceeds the OSC 52 size limit");
	}
	if (p === "linux") {
		if (env.TERMUX_VERSION) {
			throw new Error(
				"Clipboard unavailable: install the Termux:API app and `termux-api` package",
			);
		}
		if (env.WAYLAND_DISPLAY) {
			throw new Error(
				"Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access",
			);
		}
		if (env.DISPLAY) {
			throw new Error("Clipboard unavailable: install `xclip` or `xsel`, or check X11 access");
		}
	}
	throw new Error("Clipboard unavailable");
}
