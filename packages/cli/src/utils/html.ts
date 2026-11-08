export interface DecodedHtmlEntity {
	text: string;
	length: number;
}

const maxEntityLength = 16;

const maxCodePoint = 0x10ffff;

const namedEntities = new Map([
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["quot", '"'],
	["apos", "'"],
]);

export function decodeHtmlEntity(entity: string): string | undefined {
	const named = namedEntities.get(entity);
	if (named !== undefined) return named;

	if (entity.startsWith("#x") || entity.startsWith("#X")) {
		return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
	}

	if (entity.startsWith("#")) {
		return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
	}

	return undefined;
}

export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
	const semicolonIndex = html.indexOf(";", index + 1);
	if (semicolonIndex === -1) return undefined;

	// Longest entity
	const entityLength = semicolonIndex - index;
	if (entityLength > maxEntityLength) return undefined;

	const entity = html.slice(index + 1, semicolonIndex);
	const decoded = decodeHtmlEntity(entity);
	if (decoded === undefined) return undefined;

	return { text: decoded, length: entityLength + 1 };
}

function decodeCodePoint(codePoint: number): string | undefined {
	if (!Number.isInteger(codePoint)) return undefined;

	const inRange = codePoint >= 0 && codePoint <= maxCodePoint;
	if (!inRange) return undefined;

	return String.fromCodePoint(codePoint);
}
