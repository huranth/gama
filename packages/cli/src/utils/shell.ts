import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

export const POWERSHELL_ARGS = [
	"-NoProfile",
	"-NonInteractive",
	"-ExecutionPolicy",
	"Bypass",
	"-Command",
] as const;

const trackedDetachedChildPids = new Set<number>();

const powershellMissingMessage = "PowerShell unavailable";

const powershellLookupMessage =
	"PowerShell not found";

const pathLookupTimeoutMs = 5000;

const gitBashSuffix = "\\Git\\bin\\bash.exe";

const localGitBashSuffix = "\\Programs\\Git\\bin\\bash.exe";

export function sanitizeBinaryOutput(value: string): string {
	return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();

	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);

	const comparePath = (value: string) =>
		process.platform === "win32" ? value.toLowerCase() : value;

	const hasBinDir = pathEntries.some((entry) => comparePath(entry) === comparePath(binDir));
	const pathParts = [binDir, currentPath].filter(Boolean);
	const updatedPath = hasBinDir ? currentPath : pathParts.join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}

	trackedDetachedChildPids.clear();
}

export function getShellConfig(customShellPath?: string): ShellConfig {
	if (customShellPath) {
		return getCustomShellConfig(customShellPath);
	}

	const platformConfig = process.platform === "win32" ? getWindowsShellConfig() : null;
	if (platformConfig) {
		return platformConfig;
	}

	return getPosixShellConfig();
}

export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error(powershellMissingMessage);
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error(powershellLookupMessage);
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

function firstMatchOn(stdout: string): string | undefined {
	const firstLine = stdout.trim().split(/\r?\n/)[0];
	return firstLine || undefined;
}

function findExecutableOnPath(executable: string): string | null {
	const isWindows = process.platform === "win32";
	const command = isWindows ? "where" : "which";

	try {
		const result = spawnSync(command, [executable], {
			encoding: "utf-8",
			timeout: pathLookupTimeoutMs,
			windowsHide: true,
		});
		if (result.status !== 0 || !result.stdout) return null;

		const firstMatch = firstMatchOn(result.stdout);
		if (!firstMatch) return null;
		if (isWindows && !existsSync(firstMatch)) return null;

		return firstMatch;
	} catch {
		return null;
	}
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	if (isLegacyWslBashPath(shell)) {
		return { shell, args: ["-s"], commandTransport: "stdin" };
	}

	return { shell, args: ["-c"] };
}

function getCustomShellConfig(customShellPath: string): ShellConfig {
	if (!existsSync(customShellPath)) {
		throw new Error("Invalid shell path");
	}

	return getBashShellConfig(customShellPath);
}

function getGitBashCandidates(): string[] {
	const paths: string[] = [];
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	const localAppData = process.env.LOCALAPPDATA;

	if (programFiles) {
		paths.push(`${programFiles}${gitBashSuffix}`);
	}

	if (programFilesX86) {
		paths.push(`${programFilesX86}${gitBashSuffix}`);
	}

	// Per-user
	if (localAppData) {
		paths.push(`${localAppData}${localGitBashSuffix}`);
	}

	return paths;
}

function buildMissingBashMessage(paths: string[]): string {
	const searched = paths.map((path) => `  ${path}`).join("\n");

	return (
		`No bash shell found. Options:\n` +
		`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
		`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
		"  3. Set shellPath in settings.json\n\n" +
		`Searched Git Bash in:\n${searched}`
	);
}

function getWindowsShellConfig(): ShellConfig {
	const paths = getGitBashCandidates();

	for (const path of paths) {
		if (existsSync(path)) {
			return getBashShellConfig(path);
		}
	}

	const bashOnPath = findExecutableOnPath("bash.exe");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	throw new Error(buildMissingBashMessage(paths));
}

function getPosixShellConfig(): ShellConfig {
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

function killPosixProcess(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

export function killProcessTree(pid: number): void {
	if (process.platform !== "win32") {
		killPosixProcess(pid);
		return;
	}

	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot) return;

	try {
		const taskkill = join(systemRoot, "System32", "taskkill.exe");
		const child = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});

		child.once("error", () => {});

		// Keep-alive
		if (typeof child.unref === "function") child.unref();
	} catch {}
}
