import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@huranth/gama-tui";
import { runClipboardCommand } from "./clipboard-command.ts";
import { isWSL } from "./wsl.ts";

const maxOsc52EncodedLength = 100_000;

const clipboardPathTimeoutMs = 1000;

const clipboardCommandTimeoutMs = 5000;

type Command = [string, string[]];

function isRemoteSession(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > maxOsc52EncodedLength) return false;

	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

function linuxReadCommands(env: NodeJS.ProcessEnv): Command[] {
	const commands: Command[] = [];

	if (env.TERMUX_VERSION) commands.push(["termux-clipboard-get", []]);
	if (env.WAYLAND_DISPLAY) commands.push(["wl-paste", ["--no-newline", "--type", "text"]]);
	if (env.DISPLAY) {
		commands.push(
			["xclip", ["-selection", "clipboard", "-out"]],
			["xsel", ["--clipboard", "--output"]],
		);
	}

	return commands;
}

function copyCommands(platformName: string, env: NodeJS.ProcessEnv): Command[] {
	const commands: Command[] = [];

	if (platformName === "darwin") {
		commands.push(["pbcopy", []]);
		return commands;
	}

	if (platformName === "win32") {
		commands.push(["clip", []]);
		return commands;
	}

	if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
	if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
	if (env.DISPLAY) {
		commands.push(
			["xclip", ["-selection", "clipboard"]],
			["xsel", ["--clipboard", "--input"]],
		);
	}

	return commands;
}

export async function readClipboardFilePaths(): Promise<string[] | null> {
	const paths = await getNativeClipboard()?.getFilePaths?.();
	return paths?.length ? paths : null;
}

export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux") {
		for (const [command, args] of linuxReadCommands(process.env)) {
			const bytes = await runClipboardCommand(command, args, {
				timeoutMs: clipboardCommandTimeoutMs,
			});
			if (bytes !== undefined) return bytes.toString("utf8") || null;
		}
	}

	try {
		return (await getNativeClipboard()?.getText()) || null;
	} catch {
		return null;
	}
}

async function copyViaWindowsClipboard(text: string): Promise<boolean> {
	const tmpFile = join(tmpdir(), `gama-wsl-clip-${randomUUID()}.txt`);

	try {
		writeFileSync(tmpFile, text, { encoding: "utf8", mode: 0o600 });

		const winPathResult = await runClipboardCommand("wslpath", ["-w", tmpFile], {
			timeoutMs: clipboardPathTimeoutMs,
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
			{ timeoutMs: clipboardCommandTimeoutMs },
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

async function copyViaNative(text: string): Promise<boolean> {
	try {
		const clipboard = getNativeClipboard();
		if (!clipboard?.setText) return false;

		await clipboard.setText(text);
		return true;
	} catch {
		return false;
	}
}

async function copyViaCommands(text: string, commands: Command[]): Promise<boolean> {
	for (const [command, args] of commands) {
		const result = await runClipboardCommand(command, args, {
			input: text,
			timeoutMs: clipboardCommandTimeoutMs,
		});
		if (result !== undefined) return true;
	}

	return false;
}

function clipboardUnavailableError(): Error {
	return new Error("Clipboard unavailable");
}

export async function copyToClipboard(text: string): Promise<void> {
	const platformName = platform();
	const env = process.env;

	let copied = platformName === "linux" ? false : await copyViaNative(text);
	if (!copied) copied = await copyViaCommands(text, copyCommands(platformName, env));

	let osc52Emitted = false;
	if (!copied && platformName === "linux" && isWSL(env)) {
		if (env.WT_SESSION) osc52Emitted = emitOsc52(text);
		copied = osc52Emitted || (await copyViaWindowsClipboard(text));
	}

	const noDisplay = !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	const headless = platformName === "linux" && noDisplay;
	const needsOsc52 = isRemoteSession(env) || (!copied && headless);

	let oversized = false;
	if (!osc52Emitted && needsOsc52) {
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}

	if (copied) return;
	if (oversized) {
		throw new Error("Clipboard too large");
	}

	throw clipboardUnavailableError();
}
