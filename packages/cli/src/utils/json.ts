const stringOrComment = /"(?:\\.|[^"\\])*"|\/\/[^\n]*/g;

const stringOrTrailingComma = /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stripJsonComments(input: string): string {
	const withoutComments = input.replace(stringOrComment, (match) =>
		match[0] === '"' ? match : "",
	);

	return withoutComments.replace(stringOrTrailingComma, (match, tail: string | undefined) =>
		tail ?? (match[0] === '"' ? match : ""),
	);
}
