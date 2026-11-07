import { spawn } from "node:child_process";

const linuxCommand: [string, string[]] = ["xdg-open", []];

const openCommands: Record<string, [string, string[]]> = {
	darwin: ["open", []],
	win32: ["rundll32", ["url.dll,FileProtocolHandler"]],
	linux: linuxCommand,
};

export function openBrowser(target: string): void {
	const [command, baseArgs] = openCommands[process.platform] ?? linuxCommand;

	spawn(command, [...baseArgs, target], { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
