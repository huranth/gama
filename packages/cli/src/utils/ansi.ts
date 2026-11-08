const ansiTerminator = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

const oscSequence = `(?:\\u001B\\][\\s\\S]*?${ansiTerminator})`;

const csiSequence =
	"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

const ansiPattern = new RegExp(`${oscSequence}|${csiSequence}`, "g");

export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	const hasEscape = value.includes("\u001B") || value.includes("\u009B");
	if (!hasEscape) return value;

	return value.replace(ansiPattern, "");
}
