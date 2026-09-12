import type { JsonValue } from "@huranth/chord";

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonContainer = Record<string, JsonValue> | JsonValue[];

export function assignJson(target: JsonContainer, key: string | number, value: JsonValue): void {
	const slots = target as Record<string | number, JsonValue>;
	const current = slots[key];

	if (isRecord(current) && isRecord(value)) {
		for (const name of Object.keys(current)) {
			if (!Object.hasOwn(value, name)) delete current[name];
		}

		for (const [name, child] of Object.entries(value)) {
			assignJson(current, name, child);
		}

		return;
	}

	if (Array.isArray(current) && Array.isArray(value) && current.length <= value.length) {
		const items = current as JsonValue[];

		for (let index = 0; index < value.length; index++) {
			if (index < items.length) assignJson(items, index, value[index]!);
			else items.push(value[index]!);
		}

		return;
	}

	if (current !== value) slots[key] = value;
}
