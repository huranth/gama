export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const IDENTIFIER_START = /^[A-Za-z_$]$/;

const IDENTIFIER_PART = /^[A-Za-z0-9_$]$/;

export function toCodemodeIdentifier(name: string): string {
	let identifier = "";

	for (const char of name) {
		const test = identifier === "" ? IDENTIFIER_START : IDENTIFIER_PART;
		identifier += test.test(char) ? char : "_";
	}

	return identifier === "" ? "_" : identifier;
}
