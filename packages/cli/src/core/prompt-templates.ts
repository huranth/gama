import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./origin.ts";

const MIB_BYTES = 1024 * 1024;

const MAX_PROMPT_FILE_BYTES = 2 * MIB_BYTES;

const MAX_HINT_CHARS = 60;

const ARG_PATTERN =
	/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

export interface PromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	sourceInfo: SourceInfo;
	filePath: string;
}

export interface LoadPromptTemplatesOptions {
	cwd: string;
	agentDir: string;
	promptPaths: string[];
	includeDefaults: boolean;
}

export interface LoadPromptTemplatesResult {
	templates: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

function isUnderPath(target: string, root: string): boolean {
	const relativePath = relative(resolve(root), resolve(target));

	if (relativePath === "") return true;
	if (relativePath === ".." || isAbsolute(relativePath)) return false;

	return !relativePath.startsWith(`..${sep}`);
}

export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (const char of argsString) {
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) args.push(current);

	return args;
}

function isAllArgs(name: string): boolean {
	return name === "@" || name === "ARGUMENTS";
}

function replaceDefault(target: string, fallback: string, args: string[], allArgs: string): string {
	const value = isAllArgs(target) ? allArgs : args[Number(target) - 1];

	return value ? value : fallback;
}

function replaceSlice(startText: string, lengthText: string | undefined, args: string[]): string {
	const start = Math.max(0, Number(startText) - 1);
	if (!lengthText) return args.slice(start).join(" ");

	const length = Number(lengthText);
	return args.slice(start, start + length).join(" ");
}

function replaceSimple(name: string, args: string[], allArgs: string): string {
	if (isAllArgs(name)) return allArgs;

	return args[Number(name) - 1] ?? "";
}

export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");

	return content.replace(
		ARG_PATTERN,
		(_match, target: string, fallback: string, start: string, length: string, simple: string) => {
			if (target) return replaceDefault(target, fallback, args, allArgs);
			if (start) return replaceSlice(start, length, args);

			return replaceSimple(simple, args, allArgs);
		},
	);
}

export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1] ?? "";
	const argsString = match[2] ?? "";

	const template = templates.find((item) => item.name === templateName);
	if (!template) return text;

	return substituteArgs(template.content, parseCommandArgs(argsString));
}

function describeError(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function loadTemplateFromFile(
	filePath: string,
	sourceInfo: SourceInfo,
): { template: PromptTemplate | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	let rawContent: string;

	try {
		if (statSync(filePath).size > MAX_PROMPT_FILE_BYTES) {
			diagnostics.push({
				type: "warning",
				message: "prompt template exceeds the 2 MiB limit",
				path: filePath,
			});

			return { template: null, diagnostics };
		}

		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: describeError(error, "failed to read prompt template file"),
			path: filePath,
		});

		return { template: null, diagnostics };
	}

	let frontmatter: Record<string, unknown>;
	let body: string;

	try {
		({ frontmatter, body } = parseFrontmatter(rawContent));
	} catch (error) {
		diagnostics.push({
			type: "warning",
			message: describeError(error, "failed to parse prompt template file"),
			path: filePath,
		});

		return { template: null, diagnostics };
	}

	const name = basename(filePath).replace(/\.md$/, "");
	const hint = frontmatter["argument-hint"];
	const argumentHint = typeof hint === "string" && hint ? hint : undefined;

	return {
		template: {
			name,
			description: readDescription(frontmatter, body),
			...(argumentHint && { argumentHint }),
			content: body,
			sourceInfo,
			filePath,
		},
		diagnostics,
	};
}

function readDescription(frontmatter: Record<string, unknown>, body: string): string {
	const rawDescription = frontmatter.description;
	if (typeof rawDescription === "string" && rawDescription) return rawDescription;

	const firstLine = body.split("\n").find((line) => line.trim());
	if (!firstLine) return "";

	if (firstLine.length <= MAX_HINT_CHARS) return firstLine;

	return `${firstLine.slice(0, MAX_HINT_CHARS)}...`;
}

function loadTemplatesFromDir(
	dir: string,
	getSourceInfo: (filePath: string, baseDir: string) => SourceInfo,
): LoadPromptTemplatesResult {
	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) return { templates, diagnostics };

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (!entry.name.endsWith(".md")) continue;
			if (!isFileEntry(fullPath, entry.isFile(), entry.isSymbolicLink())) continue;

			const result = loadTemplateFromFile(fullPath, getSourceInfo(fullPath, dir));
			if (result.template) templates.push(result.template);

			diagnostics.push(...result.diagnostics);
		}
	} catch {
		// Unreadable dir
	}

	return { templates, diagnostics };
}

function isFileEntry(fullPath: string, isFile: boolean, isSymbolicLink: boolean): boolean {
	if (!isSymbolicLink) return isFile;

	try {
		return statSync(fullPath).isFile();
	} catch {
		// Broken link
		return false;
	}
}

export function loadPromptTemplates(
	options: LoadPromptTemplatesOptions,
): LoadPromptTemplatesResult {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const { promptPaths, includeDefaults } = options;

	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	const addResult = (result: LoadPromptTemplatesResult): void => {
		templates.push(...result.templates);
		diagnostics.push(...result.diagnostics);
	};

	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	const getSourceInfo = (resolvedPath: string, baseDir: string): SourceInfo => {
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalPromptsDir,
			});
		}

		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}

		return createSyntheticSourceInfo(resolvedPath, { source: "local", baseDir });
	};

	if (includeDefaults) {
		addResult(loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		addResult(loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}

	const seenPaths = new Set<string>();

	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (seenPaths.has(resolvedPath)) continue;
		seenPaths.add(resolvedPath);

		if (!existsSync(resolvedPath)) continue;

		try {
			const stats = statSync(resolvedPath);

			if (stats.isDirectory()) {
				addResult(loadTemplatesFromDir(resolvedPath, getSourceInfo));
				continue;
			}

			if (!stats.isFile() || !resolvedPath.endsWith(".md")) continue;

			const baseDir = dirname(resolvedPath);
			const result = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath, baseDir));
			addResult({
				templates: result.template ? [result.template] : [],
				diagnostics: result.diagnostics,
			});
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: describeError(error, "failed to read prompt template path"),
				path: resolvedPath,
			});
		}
	}

	return { templates, diagnostics };
}
