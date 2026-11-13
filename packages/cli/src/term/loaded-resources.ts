import type { Container } from "@huranth/gama-tui";
import { Spacer } from "@huranth/gama-tui";
import type { PluginHost } from "../core/ext/index.ts";
import type { SourceInfo } from "../core/origin.ts";
import type { ResourceDiagnostic } from "../core/resource-loader.ts";
import type { RunSession } from "../core/session/session.ts";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import { ExpandableText } from "./chat.ts";
import { ThemedText } from "./parts/themed-text.ts";
import {
	buildScopeGroups,
	findSourceInfoForPath,
	formatContextPath,
	formatDisplayPath,
	formatExtensionDisplayPath,
	formatPathWithSource,
	formatScopeGroups,
	getCompactExtensionLabels,
	getShortPath,
} from "./resource-paths.ts";
import { type ThemeColor, theme } from "./theme/theme.ts";

type ResourcesSession = Pick<RunSession, "extensionRunner" | "promptTemplates" | "resourceLoader">;

export type LoadedResourcesContext = {
	container: Container;
	session: ResourcesSession;
	cwd: string;
	showDetails: boolean;
	expanded: boolean;
};

export type LoadedResourcesOptions = {
	extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
	force?: boolean;
	showDiagnosticsWhenQuiet?: boolean;
};

export function formatDiagnostics(
	diagnostics: readonly ResourceDiagnostic[],
	sourceInfos: Map<string, SourceInfo>,
): string {
	const lines: string[] = [];

	const collisions = new Map<string, ResourceDiagnostic[]>();
	const otherDiagnostics: ResourceDiagnostic[] = [];

	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			const list = collisions.get(d.collision.name) ?? [];
			list.push(d);
			collisions.set(d.collision.name, list);
		} else {
			otherDiagnostics.push(d);
		}
	}

	for (const [name, collisionList] of collisions) {
		const first = collisionList[0]?.collision;
		if (!first) continue;
		lines.push(theme.fg("warning", `  "${name}" collision:`));
		const winnerSource = findSourceInfoForPath(first.winnerPath, sourceInfos);
		const winner = formatPathWithSource(first.winnerPath, winnerSource);
		lines.push(theme.fg("dim", `    ${winner} (kept)`));
		for (const d of collisionList) {
			if (!d.collision) continue;
			const loserPath = d.collision.loserPath;
			const loserSource = findSourceInfoForPath(loserPath, sourceInfos);
			const loser = formatPathWithSource(loserPath, loserSource);
			lines.push(theme.fg("dim", `    ${loser} (skipped)`));
		}
	}

	for (const d of otherDiagnostics) {
		if (d.path) {
			const formattedPath = formatPathWithSource(
				d.path,
				findSourceInfoForPath(d.path, sourceInfos),
			);
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
		} else {
			lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
		}
	}

	return lines.join("\n");
}

export function getBuiltInCommandConflictDiagnostics(
	extensionRunner: PluginHost,
): ResourceDiagnostic[] {
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	return extensionRunner
		.getRegisteredCommands()
		.filter((command) => builtinNames.has(command.name))
		.map((command) => {
			const clash = "conflicts with built-in interactive command.";
			const conflict = `Extension command '/${command.name}' ${clash}`;
			const message =
				command.invocationName === command.name
					? `${conflict} Skipping in autocomplete.`
					: `${conflict} Available as '/${command.invocationName}'.`;
			return {
				type: "warning" as const,
				message,
				path: command.sourceInfo.path,
			};
		});
}

export function renderLoadedResources(
	context: LoadedResourcesContext,
	options?: LoadedResourcesOptions,
): void {
	context.container.clear();

	const showListing = options?.force || context.showDetails;
	const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
	if (!showListing && !showDiagnostics) {
		return;
	}

	const sectionHeader = (name: string, color: ThemeColor = "mdHeading") =>
		theme.fg(color, `[${name}]`);
	const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
		const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
		if (options?.sort !== false) {
			labels.sort((a, b) => a.localeCompare(b));
		}
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addLoadedSection = (
		name: string,
		collapsedBody: () => string,
		expandedBody = collapsedBody,
		color: ThemeColor = "mdHeading",
	): void => {
		const section = new ExpandableText(
			() => `${sectionHeader(name, color)}\n${collapsedBody()}`,
			() => `${sectionHeader(name, color)}\n${expandedBody()}`,
			context.expanded,
			0,
			0,
		);
		context.container.addChild(section);
		context.container.addChild(new Spacer(1));
	};

	const skillsResult = context.session.resourceLoader.getSkills();
	const promptsResult = context.session.resourceLoader.getPrompts();
	const themesResult = context.session.resourceLoader.getThemes();
	const extensions =
		options?.extensions ??
		context.session.resourceLoader
			.getExtensions()
			.extensions.filter((extension) => !extension.hidden)
			.map((extension) => ({
				path: extension.path,
				sourceInfo: extension.sourceInfo,
			}));
	const sourceInfos = new Map<string, SourceInfo>();
	for (const extension of extensions) {
		if (extension.sourceInfo) {
			sourceInfos.set(extension.path, extension.sourceInfo);
		}
	}
	for (const skill of skillsResult.skills) {
		if (skill.sourceInfo) {
			sourceInfos.set(skill.filePath, skill.sourceInfo);
		}
	}
	for (const prompt of promptsResult.prompts) {
		if (prompt.sourceInfo) {
			sourceInfos.set(prompt.filePath, prompt.sourceInfo);
		}
	}
	for (const loadedTheme of themesResult.themes) {
		if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
			sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
		}
	}

	if (showListing) {
		const systemPromptSource = context.session.resourceLoader.getSystemPromptSource();
		const contextFiles = [
			...(systemPromptSource ? [systemPromptSource] : []),
			...context.session.resourceLoader.getAppendSystemPromptSources(),
			...context.session.resourceLoader.getAgentsFiles().agentsFiles,
		];
		if (contextFiles.length > 0) {
			context.container.addChild(new Spacer(1));
			const contextList = () =>
				contextFiles.map((f) => theme.fg("dim", `  ${formatDisplayPath(f.path)}`)).join("\n");
			const contextCompactList = () =>
				formatCompactList(
					contextFiles.map((contextFile) => formatContextPath(contextFile.path, context.cwd)),
					{ sort: false },
				);
			addLoadedSection("Context", contextCompactList, contextList);
		}

		const skills = skillsResult.skills;
		if (skills.length > 0) {
			const groups = buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			const skillList = () =>
				formatScopeGroups(groups, {
					formatPath: (item) => formatDisplayPath(item.path),
					formatPackagePath: (item) => getShortPath(item.path, item.sourceInfo),
				});
			const skillCompactList = () => formatCompactList(skills.map((skill) => skill.name));
			addLoadedSection("Skills", skillCompactList, skillList);
		}

		const templates = context.session.promptTemplates;
		if (templates.length > 0) {
			const groups = buildScopeGroups(
				templates.map((template) => ({
					path: template.filePath,
					sourceInfo: template.sourceInfo,
				})),
			);
			const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
			const templateList = () =>
				formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : formatDisplayPath(item.path);
					},
				});
			const promptCompactList = () =>
				formatCompactList(templates.map((template) => `/${template.name}`));
			addLoadedSection("Prompts", promptCompactList, templateList);
		}

		if (extensions.length > 0) {
			const groups = buildScopeGroups(extensions);
			const extList = () =>
				formatScopeGroups(groups, {
					formatPath: (item) => formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						formatExtensionDisplayPath(getShortPath(item.path, item.sourceInfo)),
				});
			const extensionLabels = getCompactExtensionLabels(extensions);
			const extensionCompactList = () => formatCompactList(extensionLabels);
			addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
		}
	}

	if (showDiagnostics) {
		const skillDiagnostics = skillsResult.diagnostics;
		if (skillDiagnostics.length > 0) {
			const warningLines = () => formatDiagnostics(skillDiagnostics, sourceInfos);
			context.container.addChild(
				new ThemedText(
					() => `${theme.fg("warning", "[Skill conflicts]")}\n${warningLines()}`,
					0,
					0,
				),
			);
			context.container.addChild(new Spacer(1));
		}

		const promptDiagnostics = promptsResult.diagnostics;
		if (promptDiagnostics.length > 0) {
			const warningLines = () => formatDiagnostics(promptDiagnostics, sourceInfos);
			context.container.addChild(
				new ThemedText(
					() => `${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines()}`,
					0,
					0,
				),
			);
			context.container.addChild(new Spacer(1));
		}

		const extensionDiagnostics: ResourceDiagnostic[] = [];
		const extensionsResult = context.session.resourceLoader.getExtensions();
		for (const error of extensionsResult.errors) {
			extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
		}
		for (const warning of extensionsResult.warnings ?? []) {
			extensionDiagnostics.push({
				type: "warning",
				message: warning.warning,
				path: warning.path,
			});
		}

		const commandDiagnostics = context.session.extensionRunner.getCommandDiagnostics();
		extensionDiagnostics.push(...commandDiagnostics);
		extensionDiagnostics.push(
			...getBuiltInCommandConflictDiagnostics(context.session.extensionRunner),
		);

		const shortcutDiagnostics = context.session.extensionRunner.getShortcutDiagnostics();
		extensionDiagnostics.push(...shortcutDiagnostics);

		if (extensionDiagnostics.length > 0) {
			const warningLines = () => formatDiagnostics(extensionDiagnostics, sourceInfos);
			context.container.addChild(
				new ThemedText(
					() => `${theme.fg("warning", "[Extension issues]")}\n${warningLines()}`,
					0,
					0,
				),
			);
			context.container.addChild(new Spacer(1));
		}

		const themeDiagnostics = themesResult.diagnostics;
		if (themeDiagnostics.length > 0) {
			const warningLines = () => formatDiagnostics(themeDiagnostics, sourceInfos);
			context.container.addChild(
				new ThemedText(
					() => `${theme.fg("warning", "[Theme conflicts]")}\n${warningLines()}`,
					0,
					0,
				),
			);
			context.container.addChild(new Spacer(1));
		}
	}
}
