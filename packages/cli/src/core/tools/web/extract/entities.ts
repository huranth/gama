// Ascii only
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	copy: "(c)",
	gt: ">",
	hellip: "...",
	ldquo: '"',
	lsquo: "'",
	lt: "<",
	mdash: "-",
	middot: "*",
	nbsp: " ",
	ndash: "-",
	quot: '"',
	rdquo: '"',
	rsquo: "'",
};

// Entity pattern
const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

// Code names
const CODE_NAMES: readonly string[] = ["amp", "gt", "lt", "quot"];

const CODE_PATTERN = new RegExp(`&(${CODE_NAMES.join("|")});`, "g");

// Code cap
const MAX_CODE_POINT = 0x10ffff;

// Surrogate bounds
const SURROGATE_START = 0xd800;

const SURROGATE_END = 0xdfff;

// Escape decode
export function decodeHtmlEntities(text: string): string {
	return text.replace(ENTITY_PATTERN, (entity, body: string) => decodeEntity(entity, body));
}

// Code entities
export function decodeCodeEntities(text: string): string {
	return text.replace(CODE_PATTERN, (entity, name: string) => NAMED_ENTITIES[name] ?? entity);
}

// Shared decode
function decodeEntity(entity: string, body: string): string {
	if (body.startsWith("#")) return decodeNumeric(entity, body);

	// Named lookup
	return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

// Numeric decode
function decodeNumeric(entity: string, body: string): string {
	const isHex = body[1]?.toLowerCase() === "x";
	const digits = isHex ? body.slice(2) : body.slice(1);
	const value = Number.parseInt(digits, isHex ? 16 : 10);

	// Bad digits
	if (!Number.isFinite(value) || value < 0) return entity;

	// Check range
	const isSurrogate = value >= SURROGATE_START && value <= SURROGATE_END;
	const isBad = value === 0 || value > MAX_CODE_POINT || isSurrogate;

	// Valid point
	if (!isBad) return String.fromCodePoint(value);

	// Spec fallback
	return "\uFFFD";
}
