import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((candidate) => candidate.name === toolCall.name);

	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}

	return validateToolArguments(tool, toolCall);
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const schema = tool.parameters as JsonSchemaObject;
	const args = structuredClone(toolCall.arguments);

	normalizeOptionalNulls(args, schema);
	Value.Convert(tool.parameters, args);

	const validator = getValidator(tool.parameters);
	const isTypeboxSchema = Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND);

	if (!isTypeboxSchema) {
		const coerced = coerceWithJsonSchema(args, schema);

		if (coerced !== args) {
			if (!isObjectValue(args) || !isObjectValue(coerced)) {
				return validator.Check(coerced) ? coerced : args;
			}

			for (const key of Object.keys(args)) {
				delete args[key];
			}

			Object.assign(args, coerced);
		}
	}

	if (validator.Check(args)) return args;

	throw formatValidationFailure(toolCall, validator, args);
}

function formatValidationFailure(
	toolCall: ToolCall,
	validator: ReturnType<typeof Compile>,
	args: unknown,
): Error {
	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";

	const received = JSON.stringify(toolCall.arguments, null, 2);
	const header = `Validation failed for tool "${toolCall.name}":`;
	const details = `Received arguments:\n${received}`;

	return new Error(`${header}\n${errors}\n\n${details}`);
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);

	if (cached) return cached;

	const validator = Compile(schema);

	validatorCache.set(key, validator);

	return validator;
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return getValidator(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	for (const nested of schema.allOf ?? []) {
		nextValue = coerceWithJsonSchema(nextValue, nested);
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((type) => matchesJsonType(nextValue, type));

	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const type of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, type);

			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (schemaTypes.includes("object") && isObjectLike(nextValue)) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);

		if (validator?.Check(value)) return value;
	}

	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);

		if (validator?.Check(coerced)) return coerced;
	}

	return value;
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];

			if (!itemSchema) continue;

			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}

		return;
	}

	const itemSchema = schema.items;

	if (!itemSchema || typeof itemSchema !== "object") return;

	for (let index = 0; index < value.length; index++) {
		value[index] = coerceWithJsonSchema(value[index], itemSchema);
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	for (const [key, propertySchema] of Object.entries(properties ?? {})) {
		if (!(key in value)) continue;

		value[key] = coerceWithJsonSchema(value[key], propertySchema);
	}

	const additional = schema.additionalProperties;

	if (!additional || typeof additional !== "object") return;

	for (const [key, propertyValue] of Object.entries(value)) {
		if (definedKeys.has(key)) continue;

		value[key] = coerceWithJsonSchema(propertyValue, additional);
	}
}

function normalizeOptionalNulls(value: unknown, schema: JsonSchemaObject): void {
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index++) {
				const itemSchema = schema.items[index];

				if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
			}
		} else if (schema.items) {
			for (const item of value) {
				normalizeOptionalNulls(item, schema.items);
			}
		}

		return;
	}

	if (!isObjectLike(value) || !schema.properties) return;

	const object = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);

	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in object)) continue;

		const isOptionalNull =
			object[key] === null &&
			!required.has(key) &&
			typeof (propertySchema as { $ref?: unknown }).$ref !== "string" &&
			getSubSchemaValidator(propertySchema)?.Check(null) === false;

		if (isOptionalNull) {
			delete object[key];
			continue;
		}

		normalizeOptionalNulls(object[key], propertySchema);
	}
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number":
			return coerceNumber(value, Number.isFinite);
		case "integer":
			return coerceNumber(value, Number.isInteger);
		case "boolean":
			return coerceBoolean(value);
		case "string":
			return coerceString(value);
		case "null":
			return value === "" || value === 0 || value === false ? null : value;
		default:
			return value;
	}
}

function coerceNumber(value: unknown, accept: (value: number) => boolean): unknown {
	if (value === null) return 0;

	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);

		if (accept(parsed)) return parsed;
	}

	if (typeof value === "boolean") return value ? 1 : 0;

	return value;
}

function coerceBoolean(value: unknown): unknown {
	if (value === null) return false;
	if (value === "true" || value === 1) return true;
	if (value === "false" || value === 0) return false;

	return value;
}

function coerceString(value: unknown): unknown {
	if (value === null) return "";
	if (typeof value === "number" || typeof value === "boolean") return String(value);

	return value;
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") return [schema.type];

	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}

	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return isObjectLike(value);
		default:
			return false;
	}
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
	return isObjectValue(value) && !Array.isArray(value);
}

function isObjectValue(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");

	if (error.keyword === "required") {
		const params = error.params as { requiredProperties?: string[] };
		const requiredProperty = params.requiredProperties?.[0];

		if (requiredProperty) {
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}

	return basePath || "root";
}
