import { spawn } from "node:child_process";

const OPEN_COMMANDS: Record<string, [string, string[]]> = {
	darwin: ["open", []],
	win32: ["rundll32", ["url.dll,FileProtocolHandler"]],
	linux: ["xdg-open", []],
};

const FALLBACK_COMMAND: [string, string[]] = ["xdg-open", []];

export function openBrowser(target: string): void {
	const [cmd, baseArgs] = OPEN_COMMANDS[process.platform] ?? FALLBACK_COMMAND;

	spawn(cmd, [...baseArgs, target], { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
