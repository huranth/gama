import { toCodemodeIdentifier } from "./identifier.ts";
import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

export { toCodemodeIdentifier };

export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}

interface SchemaContext {
	root: CodemodeJsonSchema;
	resolving: Set<string>;
	expansions: number;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INDENT = "  ";
export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16_000;
const MAX_REF_EXPANSIONS = 32;

export const MCP_TYPESCRIPT_PREAMBLE = `type Role = "user" | "assistant";
type MetaObject = Record<string, unknown>;
type Annotations = {
  audience?: Role[];
  priority?: number;
  lastModified?: string;
};
type Icon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type TextResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  text: string;
};
type BlobResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  blob: string;
};
type TextContent = {
  type: "text";
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type AudioContent = {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ResourceLink = {
  icons?: Icon[];
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  size?: number;
  _meta?: MetaObject;
  type: "resource_link";
};
type EmbeddedResource = {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;
type CallToolResult<TStructured = { [key: string]: unknown }> = {
  _meta?: MetaObject;
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: TStructured;
  [key: string]: unknown;
};`;

function propertyKey(name: string): string {
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

export function renderToolSignature(
	tool: Pick<CodemodeTool, "name" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const input =
		tool.inputSchema === undefined
			? "unknown"
			: schemaToType(tool.inputSchema, {
					maxChars: options.inputMaxChars ?? DEFAULT_INPUT_SCHEMA_MAX_CHARS,
				});
	const output = renderToolOutputType(tool.outputSchema);
	return `${toCodemodeIdentifier(tool.name)}(args: ${input}): Promise<${output}>;`;
}

export function renderToolSample(
	tool: Pick<CodemodeTool, "name" | "description" | "inputSchema" | "outputSchema">,
	options: { inputMaxChars?: number } = {},
): string {
	const declaration = `declare const tools: { ${renderToolSignature(tool, options)} };`;
	const description = tool.description?.trim() ?? "";
	const heading = `${description}\n\ncodemode tool declaration:\n`;
	return `${heading}\`\`\`ts\n${declaration}\n\`\`\``;
}

export function schemaToType(
	schema: CodemodeJsonSchema,
	options: { maxChars?: number } = {},
): string {
	const type = toType(schema, { root: schema, resolving: new Set(), expansions: 0 });
	return options.maxChars !== undefined && type.length > options.maxChars ? "unknown" : type;
}

function descriptionOf(property: unknown): string {
	return isObject(property) && typeof property.description === "string"
		? property.description.trim()
		: "";
}

export function renderToolOutputType(schema: CodemodeJsonSchema | undefined): string {
	const structured = mcpStructuredContentSchema(schema);
	if (structured !== undefined) {
		const type = schemaToType(structured);
		return type === "unknown" ? "CallToolResult" : `CallToolResult<${type}>`;
	}
	return schema === undefined ? "unknown" : schemaToType(schema);
}

function renderGlobal(head: string, global: CodemodeTool, indent: string): string {
	if (global.signature !== undefined) {
		return `${docComment(global.description, indent)}${indent}${head}${global.signature};`;
	}
	const input = global.inputSchema === undefined ? "unknown" : schemaToType(global.inputSchema);
	const output = global.outputSchema === undefined ? "unknown" : schemaToType(global.outputSchema);
	const comment = docComment(global.description, indent);
	return `${comment}${indent}${head}(args: ${input}): Promise<${output}>;`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Scalar literals
function union(types: string[]): string {
	const unique = [...new Set(types)];
	if (unique.includes("unknown")) return "unknown";
	return unique.length === 0 ? "never" : unique.join(" | ");
}

function docComment(description: string | undefined, indent: string): string {
	const text = description?.trim();
	if (!text) return "";
	const lines = text.replaceAll("*/", "*\\/").split(/\r?\n/);
	if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
	const body = lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n");
	return `${indent}/**\n${body}\n${indent} */\n`;
}

function arrayType(schema: Record<string, unknown>, context: SchemaContext): string {
	if (schema.items !== undefined && !Array.isArray(schema.items)) {
		return `Array<${toType(schema.items as CodemodeJsonSchema, context)}>`;
	}
	const tuple = Array.isArray(schema.prefixItems)
		? schema.prefixItems
		: Array.isArray(schema.items)
			? schema.items
			: [];
	if (tuple.length > 0)
		return `[${tuple.map((item) => toType(item as CodemodeJsonSchema, context)).join(", ")}]`;
	return "unknown[]";
}

function literalType(value: unknown): string {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return JSON.stringify(value) ?? "unknown";
	}
	return "unknown";
}

function resolveRef(ref: string, root: CodemodeJsonSchema): CodemodeJsonSchema | undefined {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(segment);
		} catch {
			return undefined;
		}
		const key = decoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isObject(current) || !(key in current)) return undefined;
		current = current[key];
	}
	return typeof current === "boolean" || isObject(current) ? current : undefined;
}

export function renderDeclarations(options: RenderDeclarationsOptions): string {
	const sections: string[] = [];
	const tools = options.tools ?? [];
	if (tools.length > 0) {
		const members = tools.map((tool) => {
			const comment = docComment(tool.description, INDENT);
			return `${comment}${INDENT}${renderToolSignature(tool)}`;
		});
		sections.push(`declare const tools: {\n${members.join("\n")}\n};`);
	}
	const namespaces = new Map<string, string[]>();
	for (const global of options.globals ?? []) {
		const dot = global.name.indexOf(".");
		if (dot === -1) {
			sections.push(renderGlobal(`declare function ${global.name}`, global, ""));
			continue;
		}
		const namespace = global.name.slice(0, dot);
		const members = namespaces.get(namespace) ?? [];
		if (members.length === 0) namespaces.set(namespace, members);
		members.push(renderGlobal(global.name.slice(dot + 1), global, INDENT));
	}
	for (const [namespace, members] of namespaces) {
		sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
	}
	return sections.join("\n\n");
}

export function mcpStructuredContentSchema(
	schema: CodemodeJsonSchema | undefined,
): CodemodeJsonSchema | undefined {
	if (!isObject(schema) || !isObject(schema.properties)) return undefined;
	const { content, isError, _meta, structuredContent } = schema.properties;
	if (
		!isObject(content) ||
		content.type !== "array" ||
		!isObject(content.items) ||
		content.items.type !== "object"
	) {
		return undefined;
	}
	if (
		!isObject(isError) ||
		isError.type !== "boolean" ||
		!isObject(_meta) ||
		_meta.type !== "object"
	)
		return undefined;
	return isObject(structuredContent) || typeof structuredContent === "boolean"
		? structuredContent
		: true;
}

function objectType(schema: Record<string, unknown>, context: SchemaContext): string {
	const properties = isObject(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const names = Object.keys(properties).sort();
	const types = names.map((name) => toType(properties[name] as CodemodeJsonSchema, context));
	const members = names.map((name, index) => {
		const optional = required.has(name) ? "" : "?";
		return `${propertyKey(name)}${optional}: ${types[index]};`;
	});
	const additional = schema.additionalProperties;
	if (additional !== undefined && additional !== false) {
		const additionalType =
			additional === true ? "unknown" : toType(additional as CodemodeJsonSchema, context);
		// Index signature
		const indexType =
			additionalType === "unknown" ? "unknown" : union([...types, additionalType]);
		members.push(`[key: string]: ${indexType};`);
	} else if (additional === undefined && names.length === 0) {
		members.push("[key: string]: unknown;");
	}
	if (members.length === 0) return "{}";
	if (!names.some((name) => descriptionOf(properties[name]))) return `{ ${members.join(" ")} }`;

	const lines = ["{"];
	names.forEach((name, index) => {
		for (const line of descriptionOf(properties[name]).split(/\r?\n/)) {
			if (line.trim()) lines.push(`${INDENT}// ${line.trim()}`);
		}
		lines.push(`${INDENT}${members[index].replaceAll("\n", `\n${INDENT}`)}`);
	});
	for (const member of members.slice(names.length)) {
		lines.push(`${INDENT}${member}`);
	}
	lines.push("}");
	return lines.join("\n");
}

function toType(schema: CodemodeJsonSchema, context: SchemaContext): string {
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	if (!isObject(schema)) return "unknown";
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		if (context.resolving.has(ref) || context.expansions >= MAX_REF_EXPANSIONS) return "unknown";
		const target = resolveRef(ref, context.root);
		if (target === undefined) return "unknown";
		context.expansions++;
		context.resolving.add(ref);
		try {
			return toType(target, context);
		} finally {
			context.resolving.delete(ref);
		}
	}

	if ("const" in schema) return literalType(schema.const);
	if (Array.isArray(schema.enum)) return union(schema.enum.map(literalType));

	const variants = Array.isArray(schema.anyOf)
		? schema.anyOf
		: Array.isArray(schema.oneOf)
			? schema.oneOf
			: undefined;
	if (variants)
		return union(variants.map((variant) => toType(variant as CodemodeJsonSchema, context)));
	if (Array.isArray(schema.allOf)) {
		const parts = schema.allOf
			.map((part) => toType(part as CodemodeJsonSchema, context))
			.filter((part) => part !== "unknown");
		return parts.length === 0
			? "unknown"
			: parts.map((part) => (part.includes(" | ") ? `(${part})` : part)).join(" & ");
	}

	const type = schema.type;
	if (Array.isArray(type))
		return union(type.map((entry) => toType({ ...schema, type: entry }, context)));
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return arrayType(schema, context);
		case "object":
			return objectType(schema, context);
		case undefined:
			if ("properties" in schema || "additionalProperties" in schema || "required" in schema) {
				return objectType(schema, context);
			}
			if ("items" in schema || "prefixItems" in schema) return arrayType(schema, context);
			return "unknown";
		default:
			return "unknown";
	}
}
