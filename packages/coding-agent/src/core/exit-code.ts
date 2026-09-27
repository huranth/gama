// Exit labels.
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
	// Windows signals.
	9009: "command not found",
	3221225786: "interrupted",
	3221225477: "crash",
};

export function exitCodeLabel(exitCode: number): string {
	return EXIT_CODE_LABELS[exitCode] ?? "failed";
}

export function commandExitStatus(exitCode: number): string {
	return `Command failed with exit ${exitCode}`;
}
