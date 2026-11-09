import { parse } from "yaml";
import { stripBom } from "./text.ts";

type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

interface SplitFrontmatter {
	yaml: string | null;
	body: string;
}

const normalizeNewlines = (value: string): string =>
	value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yaml, body } = splitFrontmatter(content);
	if (!yaml) return { frontmatter: {} as T, body };

	const parsed = parse(yaml);
	return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;

function splitFrontmatter(content: string): SplitFrontmatter {
	const normalized = normalizeNewlines(stripBom(content));
	const opening = /^---[ \t]*\n/.exec(normalized);
	if (!opening) return { yaml: null, body: normalized };

	const yamlStart = opening[0].length;
	const closing = /\n---[ \t]*(?:\n|$)/g;

	// Skip opener
	closing.lastIndex = yamlStart - 1;
	const end = closing.exec(normalized);
	if (!end) return { yaml: null, body: normalized };

	return {
		yaml: normalized.slice(yamlStart, end.index),
		body: normalized.slice(end.index + end[0].length).trim(),
	};
}
