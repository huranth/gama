// Windows codes
const WIN_CMD_NOT_FOUND = 9009;

const WIN_CTRL_C = 3221225786;

const WIN_CRASH = 3221225477;

// Exit labels
const EXIT_CODE_LABELS: Record<number, string> = {
	2: "usage error",
	126: "not executable",
	127: "command not found",
	128: "fatal error",
	129: "hangup",
	130: "interrupted",
	131: "quit",
	134: "aborted",
	137: "killed",
	139: "segfault",
	141: "broken pipe",
	143: "terminated",
	255: "error",

	[WIN_CMD_NOT_FOUND]: "command not found",
	[WIN_CTRL_C]: "interrupted",
	[WIN_CRASH]: "crash",
};

export function exitCodeLabel(exitCode: number): string {
	return EXIT_CODE_LABELS[exitCode] ?? "failed";
}
