export interface CommandFailure {
	error: string;
	hint: string;
}

type Rule = {
	pattern: RegExp;
	error: string;
	hint: string;
};

type HintRule = {
	pattern: RegExp;
	hint: string;
};

const MAX_REASON_CHARS = 140;

const TAIL_LINES = 8;

const HEAD_LINES = 6;

const ERROR_SCAN_LINES = 80;

const STACK_FRAME = /^\s+at\s/m;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

// Named alternatives
// Exact joining
const anyOf = (...parts: string[]): string => parts.join("|");

const insensitive = (source: string): RegExp => new RegExp(source, "i");

const ERROR_WORDS = [
	"error",
	"failed",
	"failure",
	"fatal",
	"panic",
	"exception",
	"denied",
	"refused",
	"missing",
	"not found",
	"cannot",
	"can't",
	"could not",
	"unable",
	"invalid",
	"unexpected",
	"unsupported",
	"conflict",
	"timed out",
	"timeout",
	"killed",
	"aborted",
	"corrupt",
	"required",
	"exceeded",
	"overflow",
	"segmentation",
	"violation",
	"mismatch",
	"undefined",
	"not assignable",
	"no such",
	"already in use",
	"read-only",
	"out of memory",
	"permission",
	"locked",
	"busy",
];

const ERROR_WORD = insensitive(`\\b(${ERROR_WORDS.join("|")})\\b`);

const NOISE =
	/^\s*(?:at\s|file\s+".*",\s+line\s+\d+|>|\d+\s*\||\^+\s*$|[-=]{3,}\s*$|npm ERR! A complete log)/i;

export function formatFailure(failure: CommandFailure): string {
	return `Command failed\nReason: ${failure.error}\nNext: ${failure.hint}`;
}

export function describeCommandFailure(
	output: string,
	exitCode: number,
	command?: string,
): CommandFailure | undefined {
	if (exitCode === 0) return undefined;

	const scanned = outputScan(output);
	const matched = matchRule(scanned);
	if (matched) return matched;

	const exit = exitFailure(exitCode, command);
	if (exit) return exit;

	return fallbackFailure(output, exitCode, command);
}

export function formatCommandFailure(output: string, exitCode: number, command?: string): string {
	const failure = describeCommandFailure(output, exitCode, command) ?? {
		error: `Exit ${exitCode}`,
		hint: exitHint(exitCode, command),
	};

	return formatFailure(failure);
}

function outputScan(output: string): string {
	const text = cleanOutput(output);
	const lines = text.split("\n");
	const tail = lines.slice(-TAIL_LINES).join("\n");
	if (!STACK_FRAME.test(tail)) return tail;

	return [...lines.slice(0, HEAD_LINES), tail].join("\n");
}

function cleanOutput(output: string): string {
	return output.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function matchRule(text: string): CommandFailure | undefined {
	for (const rule of FAILURE_RULES) {
		if (rule.pattern.test(text)) {
			return { error: rule.error, hint: rule.hint };
		}
	}

	return undefined;
}

function exitFailure(exitCode: number, command?: string): CommandFailure | undefined {
	if (exitCode === 128) {
		return commandName(command) === "git"
			? { error: "Git fatal", hint: "Check repo" }
			: { error: "Exit 128", hint: "Check command" };
	}

	return EXIT_FAILURES[exitCode];
}

function fallbackFailure(output: string, exitCode: number, command?: string): CommandFailure {
	const line = findErrorLine(output);
	if (line) {
		return { error: line, hint: hintFor(line, exitCode, command) };
	}

	return {
		error: `Exit ${exitCode}`,
		hint: exitHint(exitCode, command),
	};
}

function findErrorLine(output: string): string | undefined {
	const lines = cleanOutput(output)
		.split("\n")
		.slice(-ERROR_SCAN_LINES)
		.map(cleanLine)
		.filter((line) => line.length > 0);

	for (const line of lines.toReversed()) {
		if (NOISE.test(line)) continue;
		if (!ERROR_WORD.test(line)) continue;
		return clipReason(line);
	}

	return undefined;
}

function cleanLine(line: string): string {
	return line.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}

function clipReason(line: string): string {
	if (line.length <= MAX_REASON_CHARS) return line;

	return `${line.slice(0, MAX_REASON_CHARS - 3)}...`;
}

function hintFor(line: string, exitCode: number, command?: string): string {
	for (const rule of HINT_RULES) {
		if (rule.pattern.test(line)) return rule.hint;
	}

	return exitHint(exitCode, command);
}

function exitHint(exitCode: number, command?: string): string {
	if (exitCode === 128) {
		return commandName(command) === "git" ? "Check repo" : "Check command";
	}

	const known = EXIT_FAILURES[exitCode];
	if (known) return known.hint;

	if (exitCode >= 3 && exitCode <= 125) return "Check script logic";
	if (exitCode === 255) return "Check script logic";

	return "Check command";
}

function commandName(command?: string): string | undefined {
	if (!command) return undefined;

	const parts = command.trim().split(/\s+/);
	const start = parts.findIndex((part) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(part));
	if (start === -1) return undefined;

	let name = parts[start] ?? "";
	if (name === "sudo" || name === "env" || name === "command" || name === "npx") {
		name = parts[start + 1] ?? name;
	}

	name = name.replace(/^['"]|['"]$/g, "");
	name = name.split(/[\\/]/).pop() ?? name;
	name = name.replace(/\.(exe|cmd|bat|ps1)$/i, "");

	return name || undefined;
}

const FAILURE_RULES: Rule[] = [
	// Git specifics
	{
		pattern: /permission denied \(publickey\)/i,
		error: "SSH key denied",
		hint: "Add SSH key",
	},
	{
		pattern: /host key verification failed|remote host identification has changed/i,
		error: "Host key changed",
		hint: "Check known_hosts",
	},
	{
		pattern: insensitive(
			anyOf(
				"ssl certificate problem",
				"certificate verify failed",
				"unable to get local issuer certificate",
			),
		),
		error: "TLS failed",
		hint: "Check certificate",
	},
	{
		pattern: /not a git repository/i,
		error: "No git",
		hint: "Git init",
	},
	{
		pattern: /is not a git command|git: '.*' is not a git command/i,
		error: "Bad git command",
		hint: "Check git help",
	},
	{
		pattern: /could not auto-detect email address|please tell me who you are/i,
		error: "Git identity missing",
		hint: "Set user email",
	},
	{
		pattern: /gpg failed to sign|gpg: signing failed/i,
		error: "GPG signing failed",
		hint: "Check GPG key",
	},
	{
		pattern: /index\.lock.*(?:exists|obtained)|unable to create .*index\.lock/i,
		error: "Git lock",
		hint: "Remove lock",
	},
	{
		pattern: /unable to write new index file/i,
		error: "Index write failed",
		hint: "Check disk",
	},
	{
		pattern: /refusing to merge unrelated histories/i,
		error: "Unrelated histories",
		hint: "Allow unrelated",
	},
	{
		pattern: /untracked working tree files would be overwritten/i,
		error: "Untracked conflict",
		hint: "Move or remove",
	},
	{
		pattern: /local changes.*would be overwritten|please commit your changes or stash them/i,
		error: "Local changes",
		hint: "Stash or commit",
	},
	{
		pattern: /merge conflict|CONFLICT \(content\)|automatic merge failed|fix conflicts/i,
		error: "Merge conflict",
		hint: "Resolve files",
	},
	{
		pattern: /unmerged files|you have unmerged paths/i,
		error: "Unmerged files",
		hint: "Resolve files",
	},
	{
		pattern: /you have not concluded your merge|MERGE_HEAD exists/i,
		error: "Merge unfinished",
		hint: "Finish merge",
	},
	{
		pattern: /rebase in progress|rebase-merge directory/i,
		error: "Rebase active",
		hint: "Finish or abort",
	},
	{
		pattern: /cherry-pick is already in progress|CHERRY_PICK_HEAD exists/i,
		error: "Cherry-pick active",
		hint: "Finish or abort",
	},
	{
		pattern: /revert is already in progress|REVERT_HEAD exists/i,
		error: "Revert active",
		hint: "Finish or abort",
	},
	{
		pattern: /detached head|not currently on a branch/i,
		error: "Detached HEAD",
		hint: "Create branch",
	},
	{
		pattern: /no upstream branch|no tracking information for the current branch/i,
		error: "No upstream",
		hint: "Set upstream",
	},
	{
		pattern: insensitive(
			anyOf(
				"updates were rejected because the remote contains work",
				"non-fast-forward",
				"failed to push some refs",
				"\\[rejected\\].*->",
			),
		),
		error: "Push rejected",
		hint: "Pull first",
	},
	{
		pattern: /branch .* is not fully merged/i,
		error: "Branch unmerged",
		hint: "Merge or force",
	},
	{
		pattern: /src refspec .* does not match any|couldn't find remote ref/i,
		error: "Remote ref missing",
		hint: "Check branch",
	},
	{
		pattern: /remote .* already exists|remote origin already exists/i,
		error: "Remote exists",
		hint: "Use another name",
	},
	{
		pattern: insensitive(
			anyOf(
				"repository not found",
				"repository .* does not exist",
				"could not read from remote repository",
			),
		),
		error: "Remote missing",
		hint: "Check remote",
	},
	{
		pattern: /authentication failed|could not read username|invalid username or password/i,
		error: "Git auth failed",
		hint: "Fix credentials",
	},
	{
		pattern: /nothing to commit, working tree clean/i,
		error: "Nothing to commit",
		hint: "No action needed",
	},
	{
		pattern: /nothing added to commit but untracked files present|no changes added to commit/i,
		error: "Nothing staged",
		hint: "Git add",
	},
	{
		pattern: /pathspec .* did not match any file|did not match any file\(s\) known to git/i,
		error: "No matching path",
		hint: "Check path",
	},
	{
		pattern: /unknown revision|bad revision|ambiguous argument|invalid reference/i,
		error: "Bad revision",
		hint: "Check ref",
	},
	{
		pattern: /a branch named .* already exists/i,
		error: "Branch exists",
		hint: "Use another name",
	},
	{
		pattern: /tag .* already exists/i,
		error: "Tag exists",
		hint: "Use another name",
	},
	{
		pattern: /destination path .* already exists and is not an empty directory/i,
		error: "Target exists",
		hint: "Use empty dir",
	},
	{
		pattern: /could not create work tree dir/i,
		error: "Worktree failed",
		hint: "Check path",
	},
	{
		pattern: /bad config|bad config line/i,
		error: "Bad git config",
		hint: "Fix config",
	},
	{
		pattern: /detected dubious ownership/i,
		error: "Untrusted repo",
		hint: "Fix ownership",
	},
	{
		pattern: /this operation must be run in a work tree/i,
		error: "No work tree",
		hint: "Check repo",
	},
	{
		pattern: /cannot do a partial commit during a merge/i,
		error: "Merge commit needed",
		hint: "Commit all",
	},
	{
		pattern: /failed to write commit object/i,
		error: "Commit failed",
		hint: "Check repo",
	},
	{
		pattern: /cannot spawn .*: no such file or directory/i,
		error: "Git helper missing",
		hint: "Check Git install",
	},
	{
		pattern: /could not resolve host|failed to connect to|unable to access .*could not resolve/i,
		error: "Network failed",
		hint: "Check network",
	},

	// Shell
	{
		pattern: insensitive(
			anyOf(
				"command not found",
				"is not recognized as an internal or external command",
				"is not recognized as a name of a cmdlet",
				"the term '.*' is not recognized",
			),
		),
		error: "Not found",
		hint: "Install",
	},
	{
		pattern: /permission denied|EACCES|access is denied|access denied/i,
		error: "Permission denied",
		hint: "Check permissions",
	},
	{
		pattern: insensitive(
			anyOf(
				"no such file or directory",
				"ENOENT",
				"the system cannot find the file specified",
				"the system cannot find the path specified",
			),
		),
		error: "Path missing",
		hint: "Check path",
	},
	{
		pattern: /address already in use|EADDRINUSE|port is already allocated/i,
		error: "Port busy",
		hint: "Free port",
	},
	{
		pattern: /is a directory|EISDIR/i,
		error: "Is a directory",
		hint: "Use file path",
	},
	{
		pattern: /not a directory|ENOTDIR/i,
		error: "Not a directory",
		hint: "Check path",
	},
	{
		pattern: /read-only file system|EROFS|read only file system/i,
		error: "Read-only disk",
		hint: "Change location",
	},
	{
		pattern: /no space left on device|ENOSPC|disk full|not enough space/i,
		error: "Disk full",
		hint: "Free disk space",
	},
	{
		pattern: /too many open files|EMFILE|ENFILE/i,
		error: "Too many files",
		hint: "Raise file limit",
	},
	{
		pattern: /text file busy|ETXTBSY/i,
		error: "File busy",
		hint: "Stop process",
	},
	{
		pattern: /argument list too long|E2BIG/i,
		error: "Args too long",
		hint: "Pass a file",
	},
	{
		pattern: /cannot allocate memory|out of memory|heap out of memory|ENOMEM|bad_alloc/i,
		error: "Out of memory",
		hint: "Free memory",
	},
	{
		pattern: /operation not permitted|EPERM/i,
		error: "Not permitted",
		hint: "Check policy",
	},
	{
		pattern: /disk quota exceeded|EDQUOT/i,
		error: "Quota full",
		hint: "Free space",
	},
	{
		pattern: /file name too long|ENAMETOOLONG/i,
		error: "Name too long",
		hint: "Shorten path",
	},
	{
		pattern: /too many levels of symbolic links|ELOOP/i,
		error: "Symlink loop",
		hint: "Fix link",
	},
	{
		pattern: /stale file handle|ESTALE/i,
		error: "Stale handle",
		hint: "Retry",
	},
	{
		pattern: /invalid cross-device link|EXDEV/i,
		error: "Cross-device move",
		hint: "Copy then delete",
	},
	{
		pattern: /file exists|EEXIST/i,
		error: "File exists",
		hint: "Use another name",
	},
	{
		pattern: /no such process|ESRCH/i,
		error: "No process",
		hint: "Check pid",
	},
	{
		pattern: /bad file descriptor|EBADF/i,
		error: "Bad handle",
		hint: "Check redirect",
	},
	{
		pattern: /invalid argument|EINVAL/i,
		error: "Bad argument",
		hint: "Check input",
	},
	{
		pattern: /resource temporarily unavailable|EAGAIN|EWOULDBLOCK/i,
		error: "Resource busy",
		hint: "Retry",
	},
	{
		pattern: /interrupted system call|EINTR/i,
		error: "Interrupted",
		hint: "Retry",
	},
	{
		pattern: /broken pipe|EPIPE/i,
		error: "Pipe closed",
		hint: "Check consumer",
	},
	{
		pattern: /cannot execute binary file|exec format error/i,
		error: "Wrong binary",
		hint: "Match platform",
	},
	{
		pattern:
			/syntax error near unexpected token|syntax error: unexpected|unexpected token.*shell/i,
		error: "Shell syntax",
		hint: "Fix command",
	},
	{
		pattern: /unexpected EOF while looking for matching|unexpected end of file/i,
		error: "Unclosed quote",
		hint: "Fix command",
	},
	{
		pattern: /bad substitution/i,
		error: "Bad expansion",
		hint: "Fix shell syntax",
	},
	{
		pattern: /unbound variable/i,
		error: "Missing variable",
		hint: "Set variable",
	},
	{
		pattern: /ambiguous redirect/i,
		error: "Bad redirect",
		hint: "Quote path",
	},
	{
		pattern: /too many arguments/i,
		error: "Too many args",
		hint: "Quote values",
	},
	{
		pattern: /integer expression expected/i,
		error: "Bad number",
		hint: "Fix condition",
	},
	{
		pattern: /missing \]/i,
		error: "Bad test",
		hint: "Fix condition",
	},
	{
		pattern: insensitive(
			anyOf(
				"the syntax of the command is incorrect",
				"was unexpected at this time",
				"the filename, directory name, or volume label syntax is incorrect",
			),
		),
		error: "Bad syntax",
		hint: "Fix command",
	},
	{
		pattern: insensitive(
			anyOf(
				"the process cannot access the file because it is being used by another process",
				"EBUSY",
				"resource busy",
			),
		),
		error: "File in use",
		hint: "Close app",
	},
	{
		pattern: /requires elevation|must be run as administrator/i,
		error: "Admin needed",
		hint: "Run as admin",
	},
	{
		pattern: /the system cannot execute the specified program|not a valid win32 application/i,
		error: "Cannot run",
		hint: "Check binary",
	},
	{
		pattern: /the network path was not found/i,
		error: "Network path",
		hint: "Check share",
	},
	{
		pattern: /not enough memory resources/i,
		error: "Low memory",
		hint: "Free memory",
	},
	{
		pattern: /stack overflow|stack smashing/i,
		error: "Stack overflow",
		hint: "Check recursion",
	},
	{
		pattern: /segmentation fault|SIGSEGV/i,
		error: "Segfault",
		hint: "Check native code",
	},
	{
		pattern: /bus error|SIGBUS/i,
		error: "Bus error",
		hint: "Check memory",
	},
	{
		pattern: /illegal instruction|SIGILL/i,
		error: "Bad instruction",
		hint: "Check binary",
	},
	{
		pattern: /floating point exception|SIGFPE/i,
		error: "Math fault",
		hint: "Check inputs",
	},
	{
		pattern: /aborted \(core dumped\)|SIGABRT/i,
		error: "Aborted",
		hint: "Check crash log",
	},
	{
		pattern: /\bkilled\b|SIGKILL|oom-kill/i,
		error: "Killed",
		hint: "Check memory",
	},
	{
		pattern: /timed out|timeout|ETIMEDOUT/i,
		error: "Timed out",
		hint: "Raise timeout",
	},
	{
		pattern: /operation canceled|operation cancelled|cancelled by user/i,
		error: "Cancelled",
		hint: "Run again",
	},

	// Node
	{
		pattern: /missing script:/i,
		error: "Script missing",
		hint: "Check scripts",
	},
	{
		pattern: /could not read package\.json|enoent.*package\.json/i,
		error: "No package.json",
		hint: "Check path",
	},
	{
		pattern: /eresolve|unable to resolve dependency tree/i,
		error: "Dependency conflict",
		hint: "Fix versions",
	},
	{
		pattern: /etarget|no matching version found/i,
		error: "No version",
		hint: "Check version",
	},
	{
		pattern: /e404|npm err! 404|npm error 404|not found - get/i,
		error: "Package missing",
		hint: "Check name",
	},
	{
		pattern: /npm err! code eacces|npm error code eacces/i,
		error: "Permission denied",
		hint: "Fix permissions",
	},
	{
		pattern: /npm err! code elifecycle|npm error code elifecycle/i,
		error: "Script failed",
		hint: "Check script error",
	},
	{
		pattern: /npm err! code enotfound|npm error code enotfound/i,
		error: "Registry missing",
		hint: "Check network",
	},
	{
		pattern: /npm err! network|npm error network|request to .* failed/i,
		error: "Network failed",
		hint: "Check network",
	},
	{
		pattern: /npm err! code econnrefused|npm error code econnrefused/i,
		error: "Registry down",
		hint: "Check registry",
	},
	{
		pattern: /unsupported engine|ebadengine/i,
		error: "Node version",
		hint: "Use supported Node",
	},
	{
		pattern: /gyp err!|node-gyp/i,
		error: "Native build failed",
		hint: "Check compiler",
	},
	{
		pattern: /could not find any python installation/i,
		error: "Python missing",
		hint: "Install Python",
	},
	{
		pattern: /cannot find module|ERR_MODULE_NOT_FOUND/i,
		error: "Module missing",
		hint: "Install module",
	},
	{
		pattern: /ERR_REQUIRE_ESM/i,
		error: "Module type",
		hint: "Use import",
	},
	{
		pattern: /ERR_UNKNOWN_FILE_EXTENSION/i,
		error: "Bad extension",
		hint: "Check config",
	},
	{
		pattern: /ERR_INVALID_URL/i,
		error: "Bad URL",
		hint: "Fix URL",
	},
	{
		pattern: /ERR_OSSL|digital envelope routines/i,
		error: "OpenSSL failed",
		hint: "Check Node/OpenSSL",
	},
	{
		pattern: /ERR_STREAM_PREMATURE_CLOSE|premature close/i,
		error: "Stream closed",
		hint: "Retry request",
	},
	{
		pattern: /unhandled promise rejection/i,
		error: "Unhandled rejection",
		hint: "Fix async code",
	},
	{
		pattern: /unhandled 'error' event/i,
		error: "Unhandled error",
		hint: "Add error handler",
	},
	{
		pattern: /FATAL ERROR: Reached heap limit/i,
		error: "Heap full",
		hint: "Raise heap size",
	},

	// Python
	{
		pattern: /ModuleNotFoundError|No module named/i,
		error: "Module missing",
		hint: "Install module",
	},
	{
		pattern: /ImportError: cannot import name|cannot import name/i,
		error: "Bad import",
		hint: "Check export",
	},
	{
		pattern: /IndentationError/i,
		error: "Indentation",
		hint: "Fix indent",
	},
	{
		pattern: /TabError/i,
		error: "Tabs mixed",
		hint: "Fix indent",
	},
	{
		pattern: /SyntaxError/i,
		error: "Syntax error",
		hint: "Fix syntax",
	},
	{
		pattern: /NameError/i,
		error: "Unknown name",
		hint: "Define name",
	},
	{
		pattern: /TypeError/i,
		error: "Type mismatch",
		hint: "Check types",
	},
	{
		pattern: /ValueError/i,
		error: "Bad value",
		hint: "Check input",
	},
	{
		pattern: /KeyError/i,
		error: "Missing key",
		hint: "Check key",
	},
	{
		pattern: /IndexError/i,
		error: "Bad index",
		hint: "Check list",
	},
	{
		pattern: /AttributeError/i,
		error: "Missing attribute",
		hint: "Check object",
	},
	{
		pattern: /FileNotFoundError/i,
		error: "File missing",
		hint: "Check path",
	},
	{
		pattern: /PermissionError/i,
		error: "Permission denied",
		hint: "Fix permissions",
	},
	{
		pattern: /no matching distribution found/i,
		error: "Package missing",
		hint: "Check name",
	},
	{
		pattern: /could not find a version that satisfies/i,
		error: "No version",
		hint: "Check version",
	},
	{
		pattern: /externally-managed-environment/i,
		error: "Managed Python",
		hint: "Use venv",
	},
	{
		pattern: /failed building wheel|subprocess-exited-with-error/i,
		error: "Build failed",
		hint: "Check compiler",
	},
	{
		pattern: /can't open file .*no such file/i,
		error: "File missing",
		hint: "Check path",
	},

	// Tests
	{
		pattern: /tests?:.*\d+ failed|test suites:.*failed|\d+ failed/i,
		error: "Tests failed",
		hint: "Fix failing test",
	},
	{
		pattern: /\btest(?:s)? failed\b|\btest failure\b/i,
		error: "Test failed",
		hint: "Fix failing test",
	},
	{
		pattern: /^\s*FAIL\s|^\s*FAILED\s/i,
		error: "Test failed",
		hint: "Fix failing test",
	},
	{
		pattern: /AssertionError|assertion failed|E\s+assert/i,
		error: "Assertion failed",
		hint: "Fix expectation",
	},
	{
		pattern: /expect\(received\)\.to|expect\(.*\)\.to/i,
		error: "Expectation failed",
		hint: "Fix assertion",
	},
	{
		pattern: /snapshot .* mismatched|snapshots?:.*failed/i,
		error: "Snapshot mismatch",
		hint: "Update snapshot",
	},
	{
		pattern: /no test files found|no tests found/i,
		error: "No tests",
		hint: "Check test path",
	},
	{
		pattern: /jest did not exit/i,
		error: "Open handles",
		hint: "Close handles",
	},
	{
		pattern: /found \d+ errors?/i,
		error: "Checks failed",
		hint: "Fix errors",
	},

	// Compile
	{
		pattern: /error TS2307/i,
		error: "Module missing",
		hint: "Install types",
	},
	{
		pattern: /error TS\d+/i,
		error: "TypeScript error",
		hint: "Fix type",
	},
	{
		pattern: /cannot find name/i,
		error: "Unknown name",
		hint: "Fix code",
	},
	{
		pattern: /property '.*' does not exist/i,
		error: "Missing property",
		hint: "Fix type",
	},
	{
		pattern: /not assignable to/i,
		error: "Type mismatch",
		hint: "Fix type",
	},
	{
		pattern: /has no exported member/i,
		error: "Missing export",
		hint: "Fix import",
	},
	{
		pattern: /could not find a declaration file/i,
		error: "Missing types",
		hint: "Install @types",
	},
	{
		pattern: /unexpected end of json input|unexpected token.*json|EJSONPARSE/i,
		error: "Bad JSON",
		hint: "Fix JSON",
	},
	{
		pattern: /yaml exception|yaml parse/i,
		error: "Bad YAML",
		hint: "Fix YAML",
	},
	{
		pattern: /toml.*(?:parse|error)/i,
		error: "Bad TOML",
		hint: "Fix TOML",
	},
	{
		pattern: /error\[E\d+\]/i,
		error: "Rust error",
		hint: "Fix code",
	},
	{
		pattern: /could not compile .* due to/i,
		error: "Compile failed",
		hint: "Fix errors",
	},
	{
		pattern: /error: linking with|undefined reference to/i,
		error: "Link failed",
		hint: "Add library",
	},
	{
		pattern: /linker .* not found/i,
		error: "Linker missing",
		hint: "Install toolchain",
	},
	{
		pattern: /fatal error: .*no such file or directory/i,
		error: "Header missing",
		hint: "Install headers",
	},
	{
		pattern: /cannot find -l/i,
		error: "Library missing",
		hint: "Install library",
	},
	{
		pattern: /go: cannot find main module/i,
		error: "No go.mod",
		hint: "Init go module",
	},
	{
		pattern: /no required module provides package/i,
		error: "Module missing",
		hint: "Run go get",
	},
	{
		pattern: /missing go\.sum entry/i,
		error: "go.sum missing",
		hint: "Tidy go module",
	},
	{
		pattern: /undefined: /i,
		error: "Undefined name",
		hint: "Fix code",
	},
	{
		pattern: /cannot use .* as .* value/i,
		error: "Type mismatch",
		hint: "Fix code",
	},
	{
		pattern: /build constraints exclude all go files/i,
		error: "No build files",
		hint: "Check tags",
	},
	{
		pattern: /cannot find symbol/i,
		error: "Symbol missing",
		hint: "Fix import",
	},
	{
		pattern: /package .* does not exist/i,
		error: "Package missing",
		hint: "Fix dependency",
	},
	{
		pattern: /BUILD FAILED/i,
		error: "Build failed",
		hint: "Fix errors",
	},
	{
		pattern: /could not resolve dependencies/i,
		error: "Dependency failed",
		hint: "Check versions",
	},
	{
		pattern: /unsupported class file major version/i,
		error: "Java version",
		hint: "Match JDK",
	},
	{
		pattern: /error: expected .* before/i,
		error: "C syntax",
		hint: "Fix code",
	},
	{
		pattern: /make: \*\*\*/i,
		error: "Make failed",
		hint: "Fix target",
	},
	{
		pattern: /no cmake_cxx_compiler/i,
		error: "Compiler missing",
		hint: "Install compiler",
	},
	{
		pattern: /cmake error/i,
		error: "CMake failed",
		hint: "Fix build",
	},
	{
		pattern: /ninja: build stopped/i,
		error: "Build failed",
		hint: "Fix errors",
	},

	// Infra
	{
		pattern: /cannot connect to the docker daemon/i,
		error: "Docker down",
		hint: "Start Docker",
	},
	{
		pattern: /permission denied.*docker daemon socket/i,
		error: "Docker socket",
		hint: "Fix group",
	},
	{
		pattern: /no such image/i,
		error: "Image missing",
		hint: "Pull image",
	},
	{
		pattern: /pull access denied/i,
		error: "Image denied",
		hint: "Log in",
	},
	{
		pattern: /manifest unknown/i,
		error: "Tag missing",
		hint: "Check tag",
	},
	{
		pattern: /no matching manifest for/i,
		error: "Wrong platform",
		hint: "Check platform",
	},
	{
		pattern: /unable to connect to the server/i,
		error: "Cluster unreachable",
		hint: "Check context",
	},
	{
		pattern: /must be logged in to the server/i,
		error: "Not logged in",
		hint: "Log in",
	},
	{
		pattern: /crashloopbackoff/i,
		error: "Crash loop",
		hint: "Check logs",
	},
	{
		pattern: /imagepullbackoff/i,
		error: "Image pull failed",
		hint: "Check image",
	},
	{
		pattern: /oomkilled/i,
		error: "OOM killed",
		hint: "Raise memory",
	},
	{
		pattern: /state lock/i,
		error: "State locked",
		hint: "Unlock state",
	},
	{
		pattern: /no configuration files/i,
		error: "No config",
		hint: "Check dir",
	},
	{
		pattern: /failed to install provider/i,
		error: "Provider failed",
		hint: "Check provider",
	},
	{
		pattern: /unable to locate credentials/i,
		error: "No AWS creds",
		hint: "Configure AWS",
	},
	{
		pattern: /expiredtoken/i,
		error: "Token expired",
		hint: "Refresh creds",
	},
	{
		pattern: /accessdenied/i,
		error: "Access denied",
		hint: "Check IAM",
	},
	{
		pattern: /invalidclienttokenid/i,
		error: "Bad AWS creds",
		hint: "Check keys",
	},

	// Network
	{
		pattern: /ECONNREFUSED|connection refused/i,
		error: "Connection refused",
		hint: "Start service",
	},
	{
		pattern: /ECONNRESET|connection reset by peer/i,
		error: "Connection reset",
		hint: "Retry",
	},
	{
		pattern: /ENOTFOUND|getaddrinfo|name or service not known/i,
		error: "Host missing",
		hint: "Check network",
	},
	{
		pattern: /EAI_AGAIN|temporary failure in name resolution/i,
		error: "DNS failed",
		hint: "Check DNS",
	},
	{
		pattern: /ENETUNREACH|network is unreachable/i,
		error: "Network down",
		hint: "Check route",
	},
	{
		pattern: /EHOSTUNREACH|no route to host/i,
		error: "Host unreachable",
		hint: "Check host",
	},
	{
		pattern: /fetch failed|socket hang up/i,
		error: "Fetch failed",
		hint: "Check network",
	},
	{
		pattern: /tls handshake|certificate (?:verify|error|expired|invalid)|x509/i,
		error: "TLS failed",
		hint: "Check certificate",
	},
	{
		pattern: /proxy (?:error|failed)|cannot connect to proxy|proxy.*(?:refused|timed out)/i,
		error: "Proxy failed",
		hint: "Check proxy",
	},
	{
		pattern: /too many redirects/i,
		error: "Redirect loop",
		hint: "Check URL",
	},
	{
		pattern: /http(?:\/\d(?:\.\d)?)?\s*401|status(?: code)?:?\s*401|\bunauthorized\b/i,
		error: "HTTP 401",
		hint: "Fix credentials",
	},
	{
		pattern: /http(?:\/\d(?:\.\d)?)?\s*403|status(?: code)?:?\s*403|\bforbidden\b/i,
		error: "HTTP 403",
		hint: "Check access",
	},
	{
		pattern: /http(?:\/\d(?:\.\d)?)?\s*404|status(?: code)?:?\s*404|\b404\b.*\bnot found\b/i,
		error: "HTTP 404",
		hint: "Check URL",
	},
	{
		pattern: /http(?:\/\d(?:\.\d)?)?\s*409|status(?: code)?:?\s*409/i,
		error: "HTTP 409",
		hint: "Resolve state",
	},
	{
		pattern: /http(?:\/\d(?:\.\d)?)?\s*422|status(?: code)?:?\s*422|\bunprocessable\b/i,
		error: "HTTP 422",
		hint: "Check input",
	},
	{
		pattern:
			/http(?:\/\d(?:\.\d)?)?\s*429|status(?: code)?:?\s*429|too many requests|rate limit/i,
		error: "HTTP 429",
		hint: "Wait and retry",
	},
	{
		pattern: insensitive(
			anyOf(
				"http(?:\\/\\d(?:\\.\\d)?)?\\s*5\\d\\d",
				"status(?: code)?:?\\s*5\\d\\d",
				"internal server error",
				"bad gateway",
				"service unavailable",
				"gateway timeout",
			),
		),
		error: "HTTP 5xx",
		hint: "Retry later",
	},
	{
		pattern: /curl: \(6\)|could not resolve host/i,
		error: "Host missing",
		hint: "Check network",
	},
	{
		pattern: /curl: \(7\)|failed to connect/i,
		error: "Connect failed",
		hint: "Start service",
	},
	{
		pattern: /curl: \(22\)/i,
		error: "HTTP error",
		hint: "Check status",
	},
	{
		pattern: /curl: \(28\)/i,
		error: "Timed out",
		hint: "Raise timeout",
	},
	{
		pattern: /curl: \(35\)|curl: \(60\)/i,
		error: "TLS failed",
		hint: "Check certificate",
	},
	{
		pattern: /curl: \(52\)|empty reply/i,
		error: "Empty reply",
		hint: "Check server",
	},
	{
		pattern: /curl: \(56\)|recv failure/i,
		error: "Receive failed",
		hint: "Check network",
	},
	{
		pattern: /curl: \(3\)|bad\/illegal format/i,
		error: "Bad URL",
		hint: "Fix URL",
	},

	// Windows
	{
		pattern: /the application was unable to start correctly/i,
		error: "App start failed",
		hint: "Check runtime",
	},
	{
		pattern: /the specified module could not be found/i,
		error: "DLL missing",
		hint: "Install runtime",
	},
	{
		pattern: /code execution cannot proceed because .* was not found/i,
		error: "DLL missing",
		hint: "Install runtime",
	},
	{
		pattern: /the parameter is incorrect/i,
		error: "Bad parameter",
		hint: "Fix command",
	},

	// Database
	{
		pattern: /authentication failed for user/i,
		error: "DB auth failed",
		hint: "Fix credentials",
	},
	{
		pattern: /database .* does not exist/i,
		error: "DB missing",
		hint: "Create database",
	},
	{
		pattern: /relation .* does not exist|no such table/i,
		error: "Table missing",
		hint: "Run migration",
	},
	{
		pattern: /duplicate key value violates unique constraint/i,
		error: "Duplicate key",
		hint: "Check data",
	},
	{
		pattern: /deadlock detected/i,
		error: "Deadlock",
		hint: "Retry",
	},
	{
		pattern: /too many connections/i,
		error: "DB full",
		hint: "Raise limit",
	},
	{
		pattern: /SQLITE_BUSY/i,
		error: "DB busy",
		hint: "Retry",
	},
	{
		pattern: /SQLITE_CANTOPEN/i,
		error: "DB missing",
		hint: "Check path",
	},
	{
		pattern: /SQLITE_CONSTRAINT/i,
		error: "Constraint failed",
		hint: "Check data",
	},
	{
		pattern: /no such column/i,
		error: "Column missing",
		hint: "Check schema",
	},
	{
		pattern: /syntax error at or near|sql syntax/i,
		error: "SQL syntax",
		hint: "Fix query",
	},
	{
		pattern: /NOAUTH Authentication required/i,
		error: "Redis auth",
		hint: "Set password",
	},
	{
		pattern: /LOADING Redis is loading/i,
		error: "Redis loading",
		hint: "Wait",
	},
	{
		pattern: /MISCONF Redis/i,
		error: "Redis config",
		hint: "Fix persistence",
	},
];

const HINT_RULES: HintRule[] = [
	{ pattern: /permission|denied|EACCES|EPERM/i, hint: "Fix permissions" },
	{ pattern: /not found|missing|no such|cannot find|ENOENT/i, hint: "Check path" },
	{ pattern: /network|connect|host|dns|resolve|refused|unreachable/i, hint: "Check network" },
	{ pattern: /timed? out|timeout/i, hint: "Raise timeout" },
	{ pattern: /syntax|unexpected|invalid|parse/i, hint: "Fix syntax" },
	{ pattern: /type|assignable|property|undefined/i, hint: "Fix type" },
	{ pattern: /module|package|dependency|import/i, hint: "Install dependency" },
	{ pattern: /test|assert|expect|snapshot/i, hint: "Fix failing test" },
	{ pattern: /config/i, hint: "Fix config" },
	{ pattern: /json|yaml|toml/i, hint: "Fix file" },
	{ pattern: /port|address already in use/i, hint: "Free port" },
	{ pattern: /memory|heap|oom/i, hint: "Free memory" },
	{ pattern: /disk|space|quota/i, hint: "Free disk space" },
	{ pattern: /conflict|merge|rebase|cherry-pick/i, hint: "Resolve conflict" },
	{ pattern: /auth|credential|token|login/i, hint: "Fix credentials" },
	{ pattern: /database|relation|table|column|redis|sql/i, hint: "Check database" },
	{ pattern: /docker|image|container/i, hint: "Check Docker" },
	{ pattern: /lock/i, hint: "Clear lock" },
	{ pattern: /version|engine/i, hint: "Check version" },
];

const EXIT_FAILURES: Readonly<Record<number, CommandFailure>> = {
	2: { error: "Usage error", hint: "Check arguments" },
	64: { error: "Usage error", hint: "Check arguments" },
	65: { error: "Data error", hint: "Check input" },
	66: { error: "Input missing", hint: "Check file" },
	67: { error: "User missing", hint: "Check user" },
	68: { error: "Host missing", hint: "Check host" },
	69: { error: "Service down", hint: "Check service" },
	70: { error: "Internal error", hint: "Check app logs" },
	71: { error: "OS error", hint: "Check system" },
	72: { error: "Critical OS file", hint: "Check system" },
	73: { error: "Output failed", hint: "Check path" },
	74: { error: "IO error", hint: "Check disk" },
	75: { error: "Temporary failure", hint: "Retry" },
	76: { error: "Protocol error", hint: "Check protocol" },
	77: { error: "Permission denied", hint: "Fix permissions" },
	78: { error: "Bad config", hint: "Fix config" },
	126: { error: "Not executable", hint: "Check permissions" },
	127: { error: "Not found", hint: "Install" },
	129: { error: "Hangup", hint: "Run again" },
	130: { error: "Interrupted", hint: "Run again" },
	131: { error: "Quit", hint: "Run again" },
	132: { error: "Bad instruction", hint: "Check binary" },
	134: { error: "Aborted", hint: "Check crash log" },
	135: { error: "Bus error", hint: "Check memory" },
	136: { error: "Math fault", hint: "Check inputs" },
	137: { error: "Killed", hint: "Check memory" },
	139: { error: "Segfault", hint: "Check native code" },
	141: { error: "Pipe closed", hint: "Check consumer" },
	143: { error: "Terminated", hint: "Check process" },
	152: { error: "CPU limit", hint: "Reduce work" },
	153: { error: "File size limit", hint: "Raise limit" },
	255: { error: "Script error", hint: "Check script logic" },
	9009: { error: "Not found", hint: "Install" },
	3221225477: { error: "Access violation", hint: "Check native code" },
	3221225620: { error: "Divide by zero", hint: "Check inputs" },
	3221225725: { error: "Stack overflow", hint: "Check recursion" },
	3221225781: { error: "DLL missing", hint: "Install runtime" },
	3221225794: { error: "DLL init failed", hint: "Check runtime" },
	3221226505: { error: "Stack overrun", hint: "Check native code" },
};
