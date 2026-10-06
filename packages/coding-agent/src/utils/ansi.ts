const ANSI_TERMINATOR = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

const OSC_SEQUENCE = `(?:\\u001B\\][\\s\\S]*?${ANSI_TERMINATOR})`;

const CSI_SEQUENCE =
	"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

const ANSI_PATTERN = `${OSC_SEQUENCE}|${CSI_SEQUENCE}`;

function ansiRegex({ onlyFirst = false }: { onlyFirst?: boolean } = {}): RegExp {
	const flags = onlyFirst ? undefined : "g";
	return new RegExp(ANSI_PATTERN, flags);
}

const ansiPattern = ansiRegex();

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	const hasEscape = value.includes("\u001B") || value.includes("\u009B");
	if (!hasEscape) return value;

	return value.replace(ansiPattern, "");
}
