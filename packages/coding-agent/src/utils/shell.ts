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

const POWERSHELL_MISSING_MESSAGE = "The powershell tool is only available on Windows.";

export function sanitizeBinaryOutput(str: string): string {
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
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
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir
		? currentPath
		: [binDir, currentPath].filter(Boolean).join(delimiter);

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

export function killProcessTree(pid: number): void {
	if (process.platform !== "win32") {
		killPosixProcess(pid);
		return;
	}

	try {
		const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
		const child = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});

		child.once("error", () => {});
	} catch {}
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

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell)
		? { shell, args: ["-s"], commandTransport: "stdin" }
		: { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
	if (process.platform !== "win32") {
		return findOnPosixPath(executable);
	}

	try {
		const result = spawnSync("where", [executable], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch && existsSync(firstMatch)) {
				return firstMatch;
			}
		}
	} catch {}

	return null;
}

function findOnPosixPath(executable: string): string | null {
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {}

	return null;
}

export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error(POWERSHELL_MISSING_MESSAGE);
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error(
			"No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.",
		);
	}

	return { shell, args: [...POWERSHELL_ARGS] };
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

function getCustomShellConfig(customShellPath: string): ShellConfig {
	if (!existsSync(customShellPath)) {
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	return getBashShellConfig(customShellPath);
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

function getGitBashCandidates(): string[] {
	const paths: string[] = [];
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];

	if (programFiles) {
		paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
	}

	if (programFilesX86) {
		paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
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
