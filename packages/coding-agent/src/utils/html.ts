function decodeCodePoint(codePoint: number): string | undefined {
	if (!Number.isInteger(codePoint)) return undefined;

	const inRange = codePoint >= 0 && codePoint <= 0x10ffff;
	if (!inRange) return undefined;

	return String.fromCodePoint(codePoint);
}

export interface DecodedHtmlEntity {
	text: string;
	length: number;
}

export function decodeHtmlEntity(entity: string): string | undefined {
	switch (entity) {
		case "amp":
			return "&";
		case "lt":
			return "<";
		case "gt":
			return ">";
		case "quot":
			return '"';
		case "apos":
			return "'";
	}

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

	const entityLength = semicolonIndex - index;
	if (entityLength > 16) return undefined;

	const entity = html.slice(index + 1, semicolonIndex);
	const decoded = decodeHtmlEntity(entity);
	if (decoded === undefined) return undefined;

	return { text: decoded, length: entityLength + 1 };
}
