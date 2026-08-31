import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);

		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}

		throw error;
	}
}

export function parseStreamingJson<T = Record<string, unknown>>(
	partialJson: string | undefined,
): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		const rawResult = parsePartial(partialJson);
		const repairedResult = parsePartial(repairJson(partialJson));

		if (rawResult === undefined) return (repairedResult ?? {}) as T;
		if (repairedResult === undefined) return rawResult as T;

		const repairedSize = serializedLength(repairedResult);
		const rawSize = serializedLength(rawResult);

		return (repairedSize >= rawSize ? repairedResult : rawResult) as T;
	}
}

export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;

			if (char === '"') inString = true;

			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;

			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];

			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);

				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

function parsePartial<T>(json: string): T | undefined {
	try {
		return (partialParse(json) ?? {}) as T;
	} catch {
		return undefined;
	}
}

function serializedLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);

	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default: {
			const code = char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000";

			return `\\u${code}`;
		}
	}
}
