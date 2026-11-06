import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath, toPosixPath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { addIgnoreRules, markDirectoryVisited } from "./resource-scan.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./origin.ts";

type IgnoreMatcher = ReturnType<typeof ignore>;

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadSkillsFromDirOptions {
	dir: string;
	source: string;
}

export interface LoadSkillsOptions {
	cwd: string;
	agentDir: string;
	skillPaths: string[];
	includeDefaults: boolean;
}

const MAX_NAME_LENGTH = 64;

const MAX_DESCRIPTION_LENGTH = 1024;

const MIB_BYTES = 1024 * 1024;

const MAX_SKILL_FILE_BYTES = 2 * MIB_BYTES;

function pushWarnings(diagnostics: ResourceDiagnostic[], messages: string[], path: string): void {
	for (const message of messages) {
		diagnostics.push({ type: "warning", message, path });
	}
}

function nameWarnings(name: string): string[] {
	const warnings: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		warnings.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		warnings.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		warnings.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		warnings.push(`name must not contain consecutive hyphens`);
	}

	return warnings;
}

function descriptionWarnings(description: unknown): string[] {
	const warnings: string[] = [];

	if (typeof description !== "string" || description.trim() === "") {
		warnings.push("description is required");
		return warnings;
	}

	if (description.length > MAX_DESCRIPTION_LENGTH) {
		warnings.push(
			`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
		);
	}

	return warnings;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

function entryIsFile(
	fullPath: string,
	entry: { isFile(): boolean; isSymbolicLink(): boolean },
): boolean {
	if (!entry.isSymbolicLink()) return entry.isFile();

	try {
		return statSync(fullPath).isFile();
	} catch {
		// Broken link
		return false;
	}
}

function findRootSkill(
	dir: string,
	entries: Array<{ name: string; isFile(): boolean; isSymbolicLink(): boolean }>,
	ig: IgnoreMatcher,
	root: string,
): string | undefined {
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;

		const fullPath = join(dir, entry.name);
		if (!entryIsFile(fullPath, entry)) continue;

		const relPath = toPosixPath(relative(root, fullPath));
		if (ig.ignores(relPath)) continue;

		return fullPath;
	}

	return undefined;
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	visited = new Set<string>(),
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		const rootSkillPath = findRootSkill(dir, entries, ig, root);
		if (rootSkillPath) {
			const result = loadSkillFromFile(rootSkillPath, source);
			if (result.skill) skills.push(result.skill);

			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}

				if (isDirectory && !markDirectoryVisited(fullPath, visited)) continue;
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root, visited);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);

				continue;
			}

			const isRootMarkdown = isFile && includeRootFiles && entry.name.endsWith(".md");
			if (!isRootMarkdown) continue;

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) skills.push(result.skill);

			diagnostics.push(...result.diagnostics);
		}
	} catch {
		// Skip unreadable
	}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	const isDeclaredSkill = basename(filePath) === "SKILL.md";

	let rawContent: string;
	try {
		if (statSync(filePath).size > MAX_SKILL_FILE_BYTES) {
			diagnostics.push({
				type: "warning",
				message: "skill file exceeds the 2 MiB limit",
				path: filePath,
			});
			return { skill: null, diagnostics };
		}
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}

	let frontmatter: SkillFrontmatter;
	try {
		({ frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent));
	} catch (error) {
		if (isDeclaredSkill) {
			const message = error instanceof Error ? error.message : "failed to parse skill file";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
		return { skill: null, diagnostics };
	}

	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	if (!isDeclaredSkill && !hasDescription) {
		return { skill: null, diagnostics };
	}

	const skillDir = dirname(filePath);
	const parentDirName = basename(skillDir);

	pushWarnings(diagnostics, descriptionWarnings(description), filePath);

	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;

	pushWarnings(diagnostics, nameWarnings(name), filePath);

	if (!hasDescription) {
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description,
			filePath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

export function formatSkillsForPrompt(
	skills: Skill[],
	fileReadTool: "read" | "bash" = "read",
): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: "Use bash to load a skill's file when the task matches its description.",
		[
			"When a skill file references a relative path, resolve it against the skill",
			"directory (parent of SKILL.md / dirname of the path) and use that absolute path",
			"in tool commands.",
		].join(" "),
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

const XML_ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

function escapeXml(str: string): string {
	return str.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char);
}

function isUnderPath(target: string, root: string): boolean {
	const relativePath = relative(resolve(root), resolve(target));

	if (relativePath === "") return true;
	if (relativePath === ".." || isAbsolute(relativePath)) return false;

	return !relativePath.startsWith(`..${sep}`);
}

export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const realPath = canonicalizePath(skill.filePath);

			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	if (includeDefaults) {
		addSkills(loadSkillsFromDirInternal(userSkillsDir, "user", true));
		addSkills(loadSkillsFromDirInternal(projectSkillsDir, "project", true));
	}

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (isUnderPath(resolvedPath, userSkillsDir) && !includeDefaults) return "user";
		if (isUnderPath(resolvedPath, projectSkillsDir) && !includeDefaults) return "project";

		return "path";
	};

	for (const rawPath of skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({
				type: "warning",
				message: "skill path does not exist",
				path: resolvedPath,
			});
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({
					type: "warning",
					message: "skill path is not a markdown file",
					path: resolvedPath,
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
