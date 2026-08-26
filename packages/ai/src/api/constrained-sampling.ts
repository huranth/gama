import type { Tool } from "../types.ts";

interface JsonSchemaObject {
	[key: string]: unknown;
	type?: unknown;
	properties?: Record<string, JsonSchemaObject | undefined>;
	required?: unknown;
}

export type UnsupportedStrictSchemaKeywordCheck = (key: string, value: unknown) => boolean;

export interface GrammarConstrainedSampling {
	format: "lark" | "regex";
	definition: string;
	inputProperty: string;
}

export interface GrammarToolInputJsonBuffer {
	input: string;
	started: boolean;
	closed: boolean;
}

const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
] as const;

class UnsupportedStrictJsonSchemaError extends Error {}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	if (typeof value !== "object") return false;
	if (value === null) return false;

	return !Array.isArray(value);
}

function schemaTypes(schema: JsonSchemaObject): unknown[] {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return schema.type;

	return [];
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;

	const types = schemaTypes(schema);
	if (types.includes("null")) return true;
	if (schema.const === null) return true;

	const values = Array.isArray(schema.enum) ? schema.enum : [];
	if (values.includes(null)) return true;

	const variants = Array.isArray(schema.anyOf) ? schema.anyOf : [];

	return variants.some((variant) => schemaAllowsNull(variant));
}

function isStructuredSchema(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;

	const types = schemaTypes(schema);

	return (
		types.includes("object") ||
		types.includes("array") ||
		schema.properties !== undefined ||
		schema.items !== undefined
	);
}

export function getJsonSchemaToolParameters(
	tool: Tool,
	strict: boolean | undefined,
): Tool["parameters"] {
	if (strict !== true) return tool.parameters;

	return makeStrictJsonSchema(tool.parameters) as Tool["parameters"];
}

export function getGrammarToolInput(
	toolName: string,
	arguments_: Record<string, unknown>,
	inputProperty: string,
): string {
	const input = arguments_[inputProperty];
	if (typeof input !== "string") {
		throw new Error(
			`Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`,
		);
	}

	return input;
}

export function createGrammarToolInputProperties(
	tools: Tool[] | undefined,
	supportsOpenAIGrammarTools: boolean,
): ReadonlyMap<string, string> {
	const properties = new Map<string, string>();

	for (const tool of tools ?? []) {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) properties.set(tool.name, grammar.inputProperty);
	}

	return properties;
}

export function resolveJsonSchemaStrictSampling(
	tool: Tool,
	supportsStrictMode: boolean,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): boolean | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") return undefined;

	if (!supportsStrictMode) {
		if (config.strict === "require") {
			throw new Error(
				`Tool "${tool.name}" requires JSON-schema constrained sampling, ` +
					"but strict tools are unsupported.",
			);
		}

		return undefined;
	}

	try {
		makeStrictJsonSchema(tool.parameters, isUnsupportedKeyword);

		return true;
	} catch (error) {
		if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
		if (config.strict !== "require") return undefined;

		throw new Error(
			`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`,
		);
	}
}

export function resolveGrammarConstrainedSampling(
	tool: Tool,
	supportsOpenAIGrammarTools: boolean,
): GrammarConstrainedSampling | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "grammar") return undefined;
	if (!supportsOpenAIGrammarTools) return undefined;

	const lark = config.variants.openai_lark;
	const regex = config.variants.openai_regex;
	const hasLark = typeof lark === "string" && lark.trim().length > 0;
	const hasRegex = typeof regex === "string" && regex.trim().length > 0;

	if (!hasLark && !hasRegex) {
		throw new Error(
			`Tool "${tool.name}" cannot use grammar constrained sampling: ` +
				"no supported grammar variant was provided.",
		);
	}

	try {
		return {
			format: hasLark ? "lark" : "regex",
			definition: hasLark ? lark : regex!,
			inputProperty: inferGrammarInputProperty(tool),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
	}
}

function inferGrammarInputProperty(tool: Tool): string {
	const schema = tool.parameters as JsonSchemaObject;
	if (schema.type !== "object") {
		throw new Error("grammar constrained sampling requires an object parameter schema");
	}

	const required = schema.required;
	if (!Array.isArray(required) || required.length !== 1 || typeof required[0] !== "string") {
		throw new Error("grammar constrained sampling requires exactly one required string property");
	}

	const inputProperty = required[0];
	const property = schema.properties?.[inputProperty];
	if (!property) {
		throw new Error(
			`grammar constrained sampling requires a properties entry for ${inputProperty}`,
		);
	}

	if (property.type !== "string") {
		throw new Error(
			`grammar constrained sampling property ${inputProperty} must have type string`,
		);
	}

	return inputProperty;
}

export function appendGrammarToolInputJsonDelta(
	buffer: GrammarToolInputJsonBuffer,
	inputProperty: string,
	nextInput: string,
	close: boolean,
): string | undefined {
	if (buffer.closed) {
		if (close && nextInput === buffer.input) return undefined;

		throw new Error(
			`grammar tool input for property "${inputProperty}" changed after it was closed`,
		);
	}

	if (!nextInput.startsWith(buffer.input)) {
		throw new Error(
			`grammar tool input for property "${inputProperty}" changed non-monotonically`,
		);
	}

	const inputDelta = nextInput.slice(buffer.input.length);
	if (!close && inputDelta.length === 0) return undefined;

	let delta = "";
	if (!buffer.started) {
		delta += `{${JSON.stringify(inputProperty)}:"`;
		buffer.started = true;
	}

	delta += JSON.stringify(inputDelta).slice(1, -1);
	buffer.input = nextInput;

	if (close) {
		delta += '"}';
		buffer.closed = true;
	}

	return delta;
}

export function makeStrictJsonSchema(
	schema: Tool["parameters"],
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): Record<string, unknown> {
	const cloned: unknown = structuredClone(schema);
	if (!isJsonSchemaObject(cloned)) {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}

	makeJsonSchemaNodeStrict(cloned, isUnsupportedKeyword);

	if (cloned.type !== "object") {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}

	return cloned;
}

function makeJsonSchemaNodeStrict(
	schema: unknown,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): void {
	if (!isJsonSchemaObject(schema)) {
		throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	}

	assertSupportedKeywords(schema, isUnsupportedKeyword);
	applyStrictAnyOf(schema, isUnsupportedKeyword);
	applyStrictItems(schema, isUnsupportedKeyword);
	applyStrictObject(schema, isUnsupportedKeyword);
}

function assertSupportedKeywords(
	schema: JsonSchemaObject,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): void {
	for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
		if (schema[key] !== undefined) {
			throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
		}
	}

	if (!isUnsupportedKeyword) return;

	for (const [key, value] of Object.entries(schema)) {
		if (!isUnsupportedKeyword(key, value)) continue;

		throw new UnsupportedStrictJsonSchemaError(`${key}: ${JSON.stringify(value)} is unsupported`);
	}
}

function applyStrictAnyOf(
	schema: JsonSchemaObject,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): void {
	if (schema.anyOf === undefined) return;

	const variants = schema.anyOf;
	if (!Array.isArray(variants) || variants.length === 0) {
		throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
	}

	for (const variant of variants) {
		if (isStructuredSchema(variant)) {
			throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
		}

		makeJsonSchemaNodeStrict(variant, isUnsupportedKeyword);
	}
}

function applyStrictItems(
	schema: JsonSchemaObject,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): void {
	if (schema.items === undefined) return;
	if (Array.isArray(schema.items)) {
		throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
	}

	makeJsonSchemaNodeStrict(schema.items, isUnsupportedKeyword);
}

function applyStrictObject(
	schema: JsonSchemaObject,
	isUnsupportedKeyword?: UnsupportedStrictSchemaKeywordCheck,
): void {
	const isObjectSchema = schema.type === "object";

	if (schema.properties !== undefined && !isObjectSchema) {
		throw new UnsupportedStrictJsonSchemaError("properties require type object");
	}

	if (!isObjectSchema) return;

	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
		throw new UnsupportedStrictJsonSchemaError(
			"schema-valued or true additionalProperties is unsupported",
		);
	}

	if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
		throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	}

	assertRequiredIsStringArray(schema.required);

	const properties = schema.properties ?? {};
	const names = Object.keys(properties);
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	if ([...required].some((key) => !names.includes(key))) {
		throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
	}

	for (const [key, property] of Object.entries(properties)) {
		makeJsonSchemaNodeStrict(property, isUnsupportedKeyword);

		if (!required.has(key) && !schemaAllowsNull(property)) {
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}

	schema.required = names;
	schema.additionalProperties = false;
}

function assertRequiredIsStringArray(required: unknown): void {
	if (required === undefined) return;

	const isValid = Array.isArray(required) && required.every((key) => typeof key === "string");
	if (isValid) return;

	throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
}
